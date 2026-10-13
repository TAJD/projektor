import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProject, seedProjectFixture, toolError } from "./helpers";

// PROJ-1030/1031/1032/1034/1035: argument handling bugs found by the PROJ-1007 schema audit.
describe("MCP argument coercion fixes", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	async function rpc(method: string, params: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous JSON-RPC results
		return (await res.json()) as any;
	}

	async function call(name: string, args: Record<string, unknown>) {
		const json = await rpc("tools/call", { name, arguments: args });
		const text = json.result?.content?.[0]?.text;
		return { err: toolError(json), data: text ? JSON.parse(text) : undefined };
	}

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "admin" }));
	});

	describe("PROJ-1030: list_projects includeArchived string forms", () => {
		beforeEach(async () => {
			const archived = await seedProject(workspaceId, "ARCH");
			await env.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
				.bind(Math.floor(Date.now() / 1000), archived.id)
				.run();
		});

		const keys = (data: unknown) => {
			const rows = (Array.isArray(data) ? data : (data as { items: unknown[] }).items) as Array<{
				key: string;
			}>;
			return rows.map((p) => p.key).sort();
		};

		for (const value of ["false", "0", false]) {
			it(`includeArchived: ${JSON.stringify(value)} excludes archived projects`, async () => {
				const res = await call("list_projects", { includeArchived: value });
				expect(res.err).toBeUndefined();
				expect(keys(res.data)).toEqual(["PROJ"]);
			});
		}

		for (const value of ["true", "1", true]) {
			it(`includeArchived: ${JSON.stringify(value)} includes archived projects`, async () => {
				const res = await call("list_projects", { includeArchived: value });
				expect(res.err).toBeUndefined();
				expect(keys(res.data)).toEqual(["ARCH", "PROJ"]);
			});
		}
	});

	describe("PROJ-1031: fields accepts parent_ref", () => {
		it("returns parent_ref on get_issue, list_issues and get_issues", async () => {
			const parent = await seedIssue(workspaceId, projectId, userId, { title: "Parent" });
			const child = await seedIssue(workspaceId, projectId, userId, {
				title: "Child",
				parentId: parent.id,
			});
			const parentRef = `PROJ-${parent.number}`;

			const one = await call("get_issue", { id: child.id, fields: ["parent_ref"] });
			expect(one.err).toBeUndefined();
			expect(one.data.parent_ref).toBe(parentRef);

			const list = await call("list_issues", { projectId, fields: ["title", "parent_ref"] });
			expect(list.err).toBeUndefined();
			const childRow = list.data.items.find((i: { title: string }) => i.title === "Child");
			expect(childRow.parent_ref).toBe(parentRef);

			const many = await call("get_issues", { ids: [child.id], fields: ["parent_ref"] });
			expect(many.err).toBeUndefined();
			expect(JSON.stringify(many.data)).toContain(parentRef);
		});
	});

	describe("PROJ-1032: list_issues limit default", () => {
		it("declares the schema's default of 30", async () => {
			const json = await rpc("tools/list", {});
			const tool = json.result.tools.find((t: { name: string }) => t.name === "list_issues");
			expect(tool.inputSchema.properties.limit.default).toBe(30);
		});
	});

	describe("PROJ-1034: list_messages fractional limit", () => {
		it("is a validation error naming limit over MCP", async () => {
			const res = await call("list_messages", { scope: "workspace", limit: 1.5 });
			expect(res.err?.code).toBe("validation");
			expect(Object.keys(res.err?.fields ?? {})).toContain("limit");
		});

		it("is a 400 over REST", async () => {
			const res = await SELF.fetch("http://localhost/api/agent-messages?limit=1.5", {
				headers: authHeaders(token, slug),
			});
			expect(res.status).toBe(400);
		});
	});

	describe("PROJ-1035: search_wiki numeric-string limit/offset", () => {
		beforeEach(async () => {
			for (const t of ["Alpha Guide", "Alpha Notes", "Alpha Ideas"]) {
				const res = await call("create_wiki_page", { title: t, content: "alpha content" });
				expect(res.err).toBeUndefined();
			}
		});

		const titles = (data: { items: Array<{ title: string }> }) => data.items.map((i) => i.title);

		it('limit: "2" paginates like limit: 2', async () => {
			const p1 = await call("search_wiki", { query: "alpha", limit: "2" });
			expect(p1.err).toBeUndefined();
			expect(p1.data.items).toHaveLength(2);
			expect(p1.data.next).toBe("2");

			const p2 = await call("search_wiki", { query: "alpha", limit: "2", cursor: p1.data.next });
			expect(p2.err).toBeUndefined();
			expect(p2.data.items).toHaveLength(1);
			for (const t of titles(p2.data)) expect(titles(p1.data)).not.toContain(t);
		});

		it('offset: "1" starts next after the requested page', async () => {
			const res = await call("search_wiki", { query: "alpha", limit: 1, offset: "1" });
			expect(res.err).toBeUndefined();
			expect(res.data.next).toBe("2");
		});
	});
});
