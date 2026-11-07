import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProject, seedProjectFixture, toolError } from "./helpers";

describe("PROJ-1012: create_issues and create_issue_links", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let otherRef: string;

	async function call(name: string, args: Record<string, unknown>, as = token) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(as, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const json = await res.json();
		const err = toolError(json);
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		const text = (json as any).result?.content?.[0]?.text;
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		return { err, data: (text && !err ? JSON.parse(text) : undefined) as any };
	}

	async function issueCount(): Promise<number> {
		const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE project_id = ?")
			.bind(projectId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	async function linkCount(): Promise<number> {
		const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_links WHERE workspace_id = ?")
			.bind(workspaceId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
		const other = await seedIssue(workspaceId, projectId, userId, { title: "Other" });
		otherRef = `PROJ-${other.number}`;
	});

	describe("create_issues", () => {
		it("creates the valid items and reports the rejected ones, in order", async () => {
			const before = await issueCount();
			const { err, data } = await call("create_issues", {
				projectId: "PROJ",
				items: [
					{ title: "First" },
					{ title: "Bad parent", parentId: "PROJ-9999" },
					{
						title: "With links",
						comment: "note",
						links: [{ type: "relates_to", target: otherRef }],
					},
					{
						title: "Report on an open issue",
						completionReport: { summary: "x", verification: "y" },
					},
					{ title: "Bad link", links: [{ type: "blocks", target: "PROJ-9998" }] },
				],
			});
			expect(err).toBeUndefined();
			const r = data.results;
			expect(r).toHaveLength(5);
			expect(r[0].ref).toMatch(/^PROJ-\d+$/);
			expect(r[1].error.code).toBe("not_found");
			expect(r[2].ref).toMatch(/^PROJ-\d+$/);
			expect(r[2].commentId).toEqual(expect.any(String));
			expect(r[2].linkIds).toHaveLength(1);
			expect(r[3].error).toEqual({
				code: "validation",
				message: expect.stringMatching(/completionReport/),
			});
			expect(r[4].error.message).toMatch(/PROJ-9998/);
			expect(await issueCount()).toBe(before + 2);
			expect(Number(r[2].ref.split("-")[1])).toBe(Number(r[0].ref.split("-")[1]) + 1);
		});

		it("creates a 50-item batch with distinct sequential numbers", async () => {
			const before = await issueCount();
			const items = Array.from({ length: 50 }, (_, i) => ({
				title: `Item ${i}`,
				labels: ["bulk"],
			}));
			const { err, data } = await call("create_issues", { projectId, items });
			expect(err).toBeUndefined();
			const numbers = data.results.map((r: { number: number }) => r.number);
			expect(new Set(numbers).size).toBe(50);
			expect(numbers).toEqual(numbers.map((_: number, i: number) => numbers[0] + i));
			expect(await issueCount()).toBe(before + 50);
		});

		it("rejects the whole call for a malformed item and writes nothing", async () => {
			const before = await issueCount();
			const { err } = await call("create_issues", {
				projectId,
				items: [{ title: "Fine" }, { body: "no title" }],
			});
			expect(err).toBeDefined();
			expect(await issueCount()).toBe(before);
		});

		it("rejects more than 50 items", async () => {
			const items = Array.from({ length: 51 }, (_, i) => ({ title: `Item ${i}` }));
			const { err } = await call("create_issues", { projectId, items });
			expect(err).toBeDefined();
		});

		it("rejects a viewer", async () => {
			const viewer = await seedProjectFixture({ role: "viewer" });
			const res = await SELF.fetch("http://localhost/api/issues/bulk", {
				method: "POST",
				headers: authHeaders(viewer.token, viewer.slug),
				body: JSON.stringify({ projectId: viewer.projectId, items: [{ title: "Nope" }] }),
			});
			expect(res.status).toBe(403);
		});

		it("is available over REST", async () => {
			const res = await SELF.fetch("http://localhost/api/issues/bulk", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ projectId, items: [{ title: "A" }, { title: "B" }] }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: Array<{ ref: string }> };
			expect(body.results.map((r) => r.ref)).toHaveLength(2);
		});
	});

	describe("create_issue_links", () => {
		it("creates the valid links and reports the rejected ones, in order", async () => {
			const a = await seedIssue(workspaceId, projectId, userId, { title: "A" });
			const b = await seedIssue(workspaceId, projectId, userId, { title: "B" });
			const aRef = `PROJ-${a.number}`;
			const bRef = `PROJ-${b.number}`;
			const hidden = await seedProject(workspaceId, "HIDE");
			const secret = await seedIssue(workspaceId, hidden.id, userId, { title: "Secret" });
			const seeded = await call("create_issue_link", {
				sourceIssueId: aRef,
				targetIssueId: otherRef,
				type: "relates_to",
			});
			expect(seeded.err).toBeUndefined();
			const before = await linkCount();

			const { err, data } = await call("create_issue_links", {
				links: [
					{ source: aRef, target: bRef, type: "blocks" },
					{ source: aRef, target: "PROJ-9999", type: "blocks" },
					{ source: aRef, target: aRef, type: "relates_to" },
					{ source: otherRef, target: aRef, type: "relates_to" },
					{ source: bRef, target: aRef, type: "blocked_by" },
					{ source: bRef, target: otherRef, type: "follows_from" },
					{ source: aRef, target: secret.id, type: "blocks" },
				],
			});
			expect(err).toBeUndefined();
			const r = data.results;
			expect(r[0].id).toEqual(expect.any(String));
			expect(r[1].error).toEqual({
				code: "not_found",
				message: "Target issue not found: PROJ-9999",
			});
			expect(r[2].error.message).toMatch(/itself/);
			expect(r[3].error.code).toBe("conflict");
			expect(r[4].error.message).toMatch(/links\[0\]/);
			expect(r[5].id).toEqual(expect.any(String));
			expect(r[6].error.code).toBe("not_found");
			expect(await linkCount()).toBe(before + 2);
		});

		it("creates 100 links in one call", async () => {
			const created = await call("create_issues", {
				projectId,
				items: Array.from({ length: 50 }, (_, i) => ({ title: `Child ${i}` })),
			});
			const refs: string[] = created.data.results.map((r: { ref: string }) => r.ref);
			const before = await linkCount();
			const { err, data } = await call("create_issue_links", {
				links: refs.flatMap((ref) => [
					{ source: ref, target: otherRef, type: "follows_from" },
					{ source: otherRef, target: ref, type: "blocks" },
				]),
			});
			expect(err).toBeUndefined();
			expect(data.results.every((r: { id?: string }) => typeof r.id === "string")).toBe(true);
			expect(await linkCount()).toBe(before + 100);
		});

		it("rejects more than 100 links", async () => {
			const { err } = await call("create_issue_links", {
				links: Array.from({ length: 101 }, () => ({
					source: otherRef,
					target: otherRef,
					type: "relates_to",
				})),
			});
			expect(err).toBeDefined();
		});

		it("is available over REST", async () => {
			const a = await seedIssue(workspaceId, projectId, userId, { title: "A" });
			const res = await SELF.fetch("http://localhost/api/issues/links/bulk", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({
					links: [{ source: `PROJ-${a.number}`, target: otherRef, type: "relates_to" }],
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: Array<{ id: string }> };
			expect(body.results[0].id).toEqual(expect.any(String));
		});
	});
});
