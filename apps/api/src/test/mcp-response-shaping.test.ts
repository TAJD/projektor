// PROJ-891: MCP response shaping — summary/full views, fields=, no nulls or internal ids,
// one `{items, next}` pagination shape, and a hard per-result size cap.

import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { capPage, shapeIssue, splitShapeOpts, toPage } from "../mcp/serialize";
import { seedIssue, seedProjectFixture } from "./helpers";

type Rpc = { result?: { content?: Array<{ text: string }>; isError?: boolean } };

describe("PROJ-891: serializer (unit)", () => {
	const raw = {
		id: "i1",
		workspace_id: "w",
		project_id: "p",
		number: 7,
		title: "T",
		status: "todo",
		priority: "high",
		labels: '["a","b"]',
		parent_id: null,
		assignee_id: null,
		assignee_name: null,
		type_id: "t",
		type_key: "bug",
		type_name: "Bug",
		status_id: "s",
		status_key: "todo",
		status_name: "Todo",
		status_category: "todo",
		created_by_id: "u",
		author_kind: null,
		needs_audit: false,
		completed_at: null,
		sprint_id: null,
		created_at: 1,
		updated_at: 2,
		project_key: "PROJ",
		project_name: "Projektor",
		links: [],
		customFields: [],
	};

	it("PROJ-1015: summary keeps a custom status_key, the parent's ref and a non-zero rollup", () => {
		const out = shapeIssue(
			{
				...raw,
				status: "in_progress",
				status_key: "qa",
				parent_id: "p-uuid",
				parent_ref: "PROJ-1",
				rollup: { total: 2 },
			},
			{ view: "summary" }
		);
		expect(out).toMatchObject({ status: "in_progress", status_key: "qa", parent: "PROJ-1" });
		expect(out.rollup).toEqual({ total: 2 });
		expect(shapeIssue(raw, { view: "summary" })).not.toHaveProperty("status_key");
	});

	it("full view drops nulls, empty arrays, false defaults and internal ids; parses labels; adds ref/type", () => {
		const out = shapeIssue(raw, {});
		expect(out.ref).toBe("PROJ-7");
		expect(out.type).toBe("bug");
		expect(out.labels).toEqual(["a", "b"]);
		for (const k of [
			"workspace_id",
			"project_id",
			"type_id",
			"status_id",
			"created_by_id",
			"project_key",
			"project_name",
			"type_key",
			"type_name",
			"status_key",
			"status_name",
			"parent_id",
			"assignee_id",
			"needs_audit",
			"links",
			"customFields",
			"sprint_id",
			"completed_at",
		]) {
			expect(out, k).not.toHaveProperty(k);
		}
		expect(out.status).toBe("todo");
		expect(out.priority).toBe("high");
	});

	it("summary view is {ref,title,status,priority,type,parent?,assignee?,updated}", () => {
		expect(shapeIssue(raw, { view: "summary" })).toEqual({
			ref: "PROJ-7",
			title: "T",
			status: "todo",
			priority: "high",
			type: "bug",
			updated: 2,
		});
		expect(
			shapeIssue({ ...raw, parent_id: "P", assignee_name: "Ann" }, { view: "summary" })
		).toMatchObject({ parent: "P", assignee: "Ann" });
	});

	it("verbose returns the raw row; fields picks (incl. derived ref) with null for absent values", () => {
		expect(shapeIssue(raw, { verbose: true })).toBe(raw);
		expect(shapeIssue(raw, { fields: ["ref", "assignee_id", "updated"] })).toEqual({
			ref: "PROJ-7",
			assignee_id: null,
			updated: 2,
		});
	});

	it("fields accepts a comma-separated string and rejects unknown names", () => {
		expect(splitShapeOpts({ fields: "ref, title" }).fields).toEqual(["ref", "title"]);
		expect(() => splitShapeOpts({ fields: "ref,nope" })).toThrow();
		expect(() => splitShapeOpts({ view: "tiny" })).toThrow();
	});

	it("toPage omits next when there is no further page", () => {
		expect(toPage([1])).toEqual({ items: [1] });
		expect(toPage([1], 5)).toEqual({ items: [1], next: "5" });
	});

	it("capPage keeps valid JSON under the cap, marks truncated, and resumes from the last kept item", () => {
		const items = Array.from({ length: 50 }, (_, i) => ({ n: i, pad: "x".repeat(100) }));
		const out = capPage(toPage(items, "orig"), { max: 1000, cursorOf: (i) => `c${i}` });
		const text = JSON.stringify(out);
		expect(text.length).toBeLessThanOrEqual(1000);
		expect(() => JSON.parse(text)).not.toThrow();
		expect(out.truncated).toBe(true);
		expect(out.items.length).toBeGreaterThan(0);
		expect(out.items.length).toBeLessThan(50);
		expect(out.next).toBe(`c${out.items.length - 1}`);
	});

	it("capPage without a cursor drops any stale next and hints at limit; small pages pass through", () => {
		const items = Array.from({ length: 50 }, () => ({ pad: "x".repeat(100) }));
		const out = capPage(toPage(items, "would-skip-items"), { max: 1000 });
		expect(out.truncated).toBe(true);
		expect(out.next).toBeUndefined();
		expect(out.hint).toContain("limit");

		const small = toPage([{ a: 1 }]);
		expect(capPage(small)).toBe(small);
	});
});

describe("PROJ-891 review fixes (unit)", () => {
	it("capPage backs off to a cut the tool allows (no splitting a shared timestamp)", () => {
		const ts = [1, 1, 2, 2, 2, 3, 3, 4];
		const items = ts.map((t) => ({ t, pad: "x".repeat(100) }));
		const out = capPage(toPage(items, "orig"), {
			max: 600,
			cursorOf: (i) => String(items[i].t),
			canCutAt: (kept) => items[kept - 1].t !== items[kept]?.t,
		});
		expect(out.truncated).toBe(true);
		const last = out.items[out.items.length - 1].t;
		// nothing sharing the cursor's second was left behind
		expect(items.slice(out.items.length).every((i) => i.t > last)).toBe(true);
		expect(out.next).toBe(String(last));
	});

	it("capPage returns the whole page rather than skip items when no safe cut exists", () => {
		const items = Array.from({ length: 30 }, () => ({ t: 5, pad: "x".repeat(100) }));
		const page = toPage(items, "orig");
		const out = capPage(page, {
			max: 1000,
			cursorOf: () => "5",
			canCutAt: (kept) => items[kept - 1].t !== items[kept]?.t,
		});
		expect(out).toBe(page);
	});

	it("capPage leaves an empty page alone", () => {
		const empty = toPage([]);
		expect(capPage(empty)).toBe(empty);
	});

	it("full view keeps a custom status_key that differs from the legacy status", () => {
		const base = { title: "T", status: "in_progress", project_key: "P", number: 1 };
		expect(shapeIssue({ ...base, status_key: "qa" }, {}).status_key).toBe("qa");
		expect(shapeIssue({ ...base, status_key: "in_progress" }, {})).not.toHaveProperty("status_key");
	});
});

describe("PROJ-891: MCP tools", () => {
	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "1000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	let f: Awaited<ReturnType<typeof seedProjectFixture>>;
	beforeEach(async () => {
		f = await seedProjectFixture();
	});

	async function tool<T = Record<string, unknown>>(
		name: string,
		args: Record<string, unknown> = {}
	): Promise<T> {
		const res = await SELF.fetch(`http://localhost/mcp/${f.workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const body = (await res.json()) as Rpc;
		expect(body.result?.isError, JSON.stringify(body)).toBeUndefined();
		return JSON.parse(body.result?.content?.[0].text ?? "null") as T;
	}

	it("list_issues: summary view, {items,next} pagination, and cursor continuation", async () => {
		for (let i = 0; i < 3; i++) {
			await seedIssue(f.workspaceId, f.projectId, f.userId, {
				title: `Item ${i}`,
				createdAt: 1_000 + i,
			});
		}
		const first = await tool<{ items: Array<Record<string, unknown>>; next?: string }>(
			"list_issues",
			{ view: "summary", limit: 2 }
		);
		expect(first.items).toHaveLength(2);
		expect(first.next).toBeTypeOf("string");
		expect(first).not.toHaveProperty("nextCursor");
		expect(Object.keys(first.items[0]).sort()).toEqual(
			["priority", "ref", "status", "title", "updated"].sort()
		);

		const second = await tool<{ items: Array<Record<string, unknown>>; next?: string }>(
			"list_issues",
			{ view: "summary", limit: 2, cursor: first.next }
		);
		expect(second.items).toHaveLength(1);
		expect(second.next).toBeUndefined();
		const refs = [...first.items, ...second.items].map((i) => i.ref);
		expect(new Set(refs).size).toBe(3);
	});

	it("PROJ-1015: list_issues defaults to summary rows, a 30-row page is under 4 KB, view:full restores rows", async () => {
		const parent = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Parent epic" });
		for (let i = 0; i < 29; i++) {
			await seedIssue(f.workspaceId, f.projectId, f.userId, {
				title: `Fix the board filter bug ${i}`,
				parentId: i % 2 ? parent.id : undefined,
			});
		}
		const res = await SELF.fetch(`http://localhost/mcp/${f.workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_issues", arguments: {} },
			}),
		});
		const text = ((await res.json()) as Rpc).result?.content?.[0].text ?? "";
		const page = JSON.parse(text) as { items: Array<Record<string, unknown>> };
		expect(page.items).toHaveLength(30);
		expect(new TextEncoder().encode(text).length).toBeLessThan(4096);

		const { ref: parentRef } = await tool<{ ref: string }>("get_issue", {
			id: parent.id,
			fields: ["ref"],
		});
		const child = page.items.find((i) => i.parent !== undefined);
		expect(child?.parent).toBe(parentRef);
		for (const item of page.items) {
			for (const k of ["id", "url", "created_at", "author_kind", "parent_id", "parent_ref"]) {
				expect(item).not.toHaveProperty(k);
			}
		}

		const full = await tool<{ items: Array<Record<string, unknown>> }>("list_issues", {
			view: "full",
			limit: 1,
		});
		expect(full.items[0]).toHaveProperty("id");
		expect(full.items[0]).toHaveProperty("created_at");
	});

	it("PROJ-1015: full rows omit a null parent_ref; get_issue links are {type, ref, title, status}", async () => {
		const a = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Source" });
		const b = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Target" });
		await env.DB.prepare(
			`INSERT INTO issue_links (id, workspace_id, source_issue_id, target_issue_id, type, created_by_id, created_at)
			 VALUES (?, ?, ?, ?, 'blocks', ?, ?)`
		)
			.bind(crypto.randomUUID(), f.workspaceId, a.id, b.id, f.userId, 1)
			.run();

		const got = await tool<{ links: unknown[]; parent_ref?: unknown }>("get_issue", { id: a.id });
		expect(got).not.toHaveProperty("parent_ref");
		const { ref: targetRef } = await tool<{ ref: string }>("get_issue", {
			id: b.id,
			fields: ["ref"],
		});
		expect(got.links).toEqual([
			{ type: "blocks", ref: targetRef, title: "Target", status: "backlog" },
		]);

		const raw = await tool<{ links: Array<{ linkedIssueId: string }> }>("get_issue", {
			id: a.id,
			verbose: true,
		});
		expect(raw.links[0].linkedIssueId).toBe(b.id);
	});

	it("get_issue full view has ref, an array of labels and no internal ids", async () => {
		const issue = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Shaped" });
		const got = await tool("get_issue", { id: issue.id });
		expect(got.ref).toMatch(/-\d+$/);
		expect(got).not.toHaveProperty("workspace_id");
		expect(got).not.toHaveProperty("project_id");
		expect(got).not.toHaveProperty("created_by_id");
		expect(got).not.toHaveProperty("labels"); // none set → dropped
	});

	it("list_issues: a page over the cap is cut with truncated:true and resumes via next", async () => {
		const pad = "y".repeat(400);
		for (let i = 0; i < 60; i++) {
			await seedIssue(f.workspaceId, f.projectId, f.userId, {
				title: `${pad} ${i}`,
				createdAt: 2_000 + i,
			});
		}
		const seen = new Set<string>();
		let cursor: string | undefined;
		let truncatedPages = 0;
		for (let guard = 0; guard < 10; guard++) {
			const res = await SELF.fetch(`http://localhost/mcp/${f.workspaceId}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "list_issues", arguments: { limit: 60, ...(cursor ? { cursor } : {}) } },
				}),
			});
			const text = ((await res.json()) as Rpc).result?.content?.[0].text ?? "";
			expect(text.length).toBeLessThanOrEqual(20_000);
			const page = JSON.parse(text) as {
				items: Array<{ ref: string }>;
				next?: string;
				truncated?: boolean;
			};
			if (page.truncated) truncatedPages++;
			for (const i of page.items) seen.add(i.ref);
			if (!page.next) break;
			cursor = page.next;
		}
		expect(truncatedPages).toBeGreaterThan(0);
		expect(seen.size).toBe(60); // nothing skipped, nothing repeated
	});

	it("list_comments and list_project_activity return {items}", async () => {
		const issue = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Talky" });
		await tool("add_comment", { issueId: issue.id, body: "hi" });
		const comments = await tool<{ items: Array<{ body: string }> }>("list_comments", {
			issueId: issue.id,
		});
		expect(comments.items.map((c) => c.body)).toEqual(["hi"]);
		const activity = await tool<{ items: unknown[] }>("list_project_activity", {
			projectId: f.projectId,
		});
		expect(Array.isArray(activity.items)).toBe(true);
	});

	it("search_wiki and list_wiki_changes page with next/cursor", async () => {
		for (const t of ["Alpha Guide", "Alpha Notes", "Alpha Ideas"]) {
			await tool("create_wiki_page", { title: t, content: "alpha content" });
		}
		const p1 = await tool<{ items: unknown[]; next?: string }>("search_wiki", {
			query: "alpha",
			limit: 2,
		});
		expect(p1.items).toHaveLength(2);
		expect(p1.next).toBe("2");
		const p2 = await tool<{ items: unknown[]; next?: string }>("search_wiki", {
			query: "alpha",
			limit: 2,
			cursor: p1.next,
		});
		expect(p2.items).toHaveLength(1);
		expect(p2.next).toBeUndefined();

		const changes = await tool<{ items: unknown[]; next: string }>("list_wiki_changes", {
			since: 0,
		});
		expect(changes.items.length).toBeGreaterThanOrEqual(3);
		const again = await tool<{ items: unknown[]; next?: string }>("list_wiki_changes", {
			cursor: changes.next,
		});
		expect(again.items).toEqual([]);
	});

	it("wiki_tree returns {items}", async () => {
		await tool("create_wiki_page", { title: "Root", content: "x" });
		const tree = await tool<{ items: unknown[] }>("wiki_tree", {});
		expect(tree.items.length).toBeGreaterThan(0);
	});
	it("list_comments: a capped page resumes via `next`, so no comment is lost (PROJ-1053)", async () => {
		const issue = await seedIssue(f.workspaceId, f.projectId, f.userId, { title: "Chatty" });
		for (let i = 0; i < 30; i++) {
			await tool("add_comment", { issueId: issue.id, body: `${i} ${"c".repeat(1000)}` });
		}
		const bodies: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard++) {
			const res = await tool<{ items: Array<{ body: string }>; next?: string; total: number }>(
				"list_comments",
				{ issueId: issue.id, ...(cursor ? { cursor } : {}) }
			);
			expect(res.total).toBe(30);
			bodies.push(...res.items.map((c) => c.body));
			if (!res.next) break;
			cursor = res.next;
		}
		expect(bodies).toHaveLength(30);
		expect(bodies.map((b) => Number(b.split(" ")[0])).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 30 }, (_, i) => i)
		);
	});

	it("list_wiki_changes: no changes means no `next`; an empty cursor does not replay from the epoch", async () => {
		await tool("create_wiki_page", { title: "Some Page", content: "x" });
		const future = Math.floor(Date.now() / 1000) + 3600;
		const none = await tool<{ items: unknown[]; next?: string }>("list_wiki_changes", {
			since: future,
		});
		expect(none.items).toEqual([]);
		expect(none).not.toHaveProperty("next");

		const empty = await tool<{ items: unknown[] }>("list_wiki_changes", {
			since: future,
			cursor: "",
		});
		expect(empty.items).toEqual([]);
	});

	it("list_wiki_changes: `next` advances when the batch had changes, and a section read is flagged partial", async () => {
		const slug = (
			await tool<{ slug: string }>("create_wiki_page", {
				title: "Sect Page",
				content: "# A\nalpha\n## B\nbeta\n",
			})
		).slug;
		const changes = await tool<{ items: unknown[]; next?: string }>("list_wiki_changes", {
			since: 0,
		});
		expect(changes.items.length).toBeGreaterThan(0);
		expect(changes.next).toBeTypeOf("string");
		const sec = await tool<{ contentTruncated?: boolean }>("get_wiki_page", { slug, section: "B" });
		expect(sec.contentTruncated).toBe(true);
	});
});
