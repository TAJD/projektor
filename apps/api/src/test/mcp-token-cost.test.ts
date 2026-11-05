// PROJ-1050: compact MCP shapes for the hot-path tools agents call every task loop —
// get_prioritized_issues (PROJ-1051), search_issues (PROJ-1052), list_comments
// (PROJ-1053) and get_flow_metrics' agingWip (PROJ-1054). REST keeps the raw shapes.

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture } from "./helpers";

type Rpc = { result?: { content?: Array<{ text: string }>; isError?: boolean } };

let token: string;
let slug: string;
let workspaceId: string;
let projectId: string;
let userId: string;

beforeEach(async () => {
	({ token, slug, workspaceId, projectId, userId } = await seedProjectFixture());
});

async function call(name: string, args: Record<string, unknown>) {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	const json = (await res.json()) as Rpc;
	const text = json.result?.content?.[0]?.text ?? "null";
	return { isError: json.result?.isError === true, data: JSON.parse(text) };
}

describe("PROJ-1051: get_prioritized_issues compact rows", () => {
	it("returns ref/title/status/priority/score and no internal ids by default", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "Top", priority: "urgent" });
		const { data } = await call("get_prioritized_issues", { includeNotReady: true });
		const row = data.issues[0];
		expect(row).toEqual({
			ref: "PROJ-1",
			title: "Top",
			status: "backlog",
			priority: "urgent",
			score: expect.any(Number),
			needsGrooming: true,
			missingCriteria: expect.any(Array),
		});
		expect(data.droppedNotReady).toBe(0);
	});

	it("verbose:true returns the raw rows with project_key and the score breakdown", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Top" });
		const { data } = await call("get_prioritized_issues", {
			includeNotReady: true,
			verbose: true,
		});
		expect(data.issues[0].id).toBe(issue.id);
		expect(data.issues[0].project_key).toBe("PROJ");
		expect(data.issues[0]._score_breakdown).toHaveProperty("centrality");
	});
});

describe("PROJ-1052: search_issues compact rows", () => {
	beforeEach(async () => {
		// Through REST, not seedIssue: the create path is what fills the FTS index.
		await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Widget crash", priority: "high" }),
		});
	});

	it("defaults to {ref,title,status,priority}", async () => {
		const { data } = await call("search_issues", { query: "Widget" });
		expect(data.items).toEqual([
			{ ref: "PROJ-1", title: "Widget crash", status: "backlog", priority: "high" },
		]);
	});

	it("verbose:true returns the raw row; fields picks keys", async () => {
		const raw = await call("search_issues", { query: "Widget", verbose: true });
		expect(raw.data.items[0]).toMatchObject({ project_key: "PROJ", project_id: projectId });
		const picked = await call("search_issues", { query: "Widget", fields: ["ref", "title"] });
		expect(picked.data.items).toEqual([{ ref: "PROJ-1", title: "Widget crash" }]);
	});
});

describe("PROJ-1053: list_comments paging and slim rows", () => {
	let issueId: string;

	beforeEach(async () => {
		({ id: issueId } = await seedIssue(workspaceId, projectId, userId, { title: "Chatty" }));
		for (let n = 1; n <= 5; n++) {
			await env.DB.prepare(
				"INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
			)
				.bind(
					crypto.randomUUID(),
					issueId,
					userId,
					`comment ${n}`,
					1000 + n,
					n === 5 ? 9999 : 1000 + n
				)
				.run();
		}
	});

	it("pages oldest-first with next/total and a slim shape", async () => {
		const first = await call("list_comments", { issueId, limit: 2 });
		expect(first.data.total).toBe(5);
		expect(first.data.items.map((c: { body: string }) => c.body)).toEqual([
			"comment 1",
			"comment 2",
		]);
		expect(Object.keys(first.data.items[0]).sort()).toEqual(["author", "body", "created", "id"]);
		expect(first.data.next).toBe("2");

		const rest = await call("list_comments", { issueId, limit: 10, cursor: first.data.next });
		expect(rest.data.items.map((c: { body: string }) => c.body)).toEqual([
			"comment 3",
			"comment 4",
			"comment 5",
		]);
		expect(rest.data.next).toBeUndefined();
		expect(rest.data.items[2].edited).toBe(true);
	});

	it("latest:N returns the newest N, still oldest-first", async () => {
		const { data } = await call("list_comments", { issueId, latest: 2 });
		expect(data.items.map((c: { body: string }) => c.body)).toEqual(["comment 4", "comment 5"]);
		expect(data.next).toBeUndefined();
	});

	it("bodyChars cuts bodies; verbose returns raw rows", async () => {
		const cut = await call("list_comments", { issueId, bodyChars: 3 });
		expect(cut.data.items[0]).toMatchObject({ body: "com", bodyTruncated: true });
		const raw = await call("list_comments", { issueId, verbose: true });
		expect(raw.data.items).toHaveLength(5);
		expect(raw.data.items[0]).toHaveProperty("author_email");
	});

	it("rejects a bad cursor as a tool error", async () => {
		const { isError } = await call("list_comments", { issueId, cursor: "99" });
		expect(isError).toBe(true);
	});
});

describe("PROJ-1054: get_flow_metrics agingWip", () => {
	it("lists the oldest open items by ref with agingWipTotal; verbose keeps the raw list", async () => {
		const now = Math.floor(Date.now() / 1000);
		for (const [title, ageDays] of [
			["young", 1],
			["old", 9],
			["middle", 4],
		] as const) {
			const { id } = await seedIssue(workspaceId, projectId, userId, {
				title,
				status: "in_progress",
			});
			await env.DB.prepare("UPDATE issues SET claimed_at = ? WHERE id = ?")
				.bind(now - ageDays * 86_400, id)
				.run();
		}

		const { data } = await call("get_flow_metrics", { projectId, agingWipLimit: 2 });
		expect(data.agingWipTotal).toBe(3);
		expect(data.agingWip).toEqual([
			{ ref: "PROJ-2", title: "old", status: "in_progress", ageDays: 9 },
			{ ref: "PROJ-3", title: "middle", status: "in_progress", ageDays: 4 },
		]);

		const raw = await call("get_flow_metrics", { projectId, verbose: true });
		expect(raw.data.agingWip).toHaveLength(3);
		expect(raw.data.agingWip[0]).toHaveProperty("ageSeconds");
		expect(raw.data.agingWipTotal).toBeUndefined();
	});
});
