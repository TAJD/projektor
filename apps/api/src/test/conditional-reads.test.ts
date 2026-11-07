import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedIssue, seedProjectFixture, toolError } from "./helpers";

describe("PROJ-1022: conditional reads", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let issueRef: string;

	async function rpc(method: string, params: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		return res.json();
	}

	async function call(name: string, args: Record<string, unknown>) {
		const json = await rpc("tools/call", { name, arguments: args });
		const err = toolError(json);
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		const text = (json as any).result?.content?.[0]?.text;
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		return { err, data: (text && !err ? JSON.parse(text) : undefined) as any };
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
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Conditional" });
		issueRef = `PROJ-${issue.number}`;
	});

	it("advertises ifVersion on the three versioned tools only", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: tools/list result
		const json = (await rpc("tools/list", {})) as any;
		const props = (name: string) =>
			// biome-ignore lint/suspicious/noExplicitAny: tools/list result
			json.result.tools.find((t: any) => t.name === name).inputSchema.properties;
		for (const name of ["get_issue", "get_wiki_page", "get_playbook"]) {
			expect(props(name).ifVersion).toBeDefined();
		}
		expect(props("list_issues").ifVersion).toBeUndefined();
	});

	describe("get_issue", () => {
		it("returns {unchanged, version} for a matching version", async () => {
			const first = await call("get_issue", { id: issueRef });
			expect(first.data.version).toMatch(/^[0-9a-f]{12}$/);
			const again = await call("get_issue", { id: issueRef, ifVersion: first.data.version });
			expect(again.data).toEqual({ unchanged: true, version: first.data.version });
		});

		it("returns the full issue when a stale version is passed", async () => {
			const { data } = await call("get_issue", { id: issueRef, ifVersion: "000000000000" });
			expect(data.title).toBe("Conditional");
			expect(data.version).toMatch(/^[0-9a-f]{12}$/);
		});

		it("sees a new link even though updated_at did not move", async () => {
			const first = await call("get_issue", { id: issueRef });
			const other = await seedIssue(workspaceId, projectId, userId, { title: "Other" });
			const linked = await call("create_issue_link", {
				sourceIssueId: issueRef,
				targetIssueId: `PROJ-${other.number}`,
				type: "relates_to",
			});
			expect(linked.err).toBeUndefined();
			const again = await call("get_issue", { id: issueRef, ifVersion: first.data.version });
			expect(again.data.unchanged).toBeUndefined();
			expect(again.data.links).toHaveLength(1);
			expect(again.data.version).not.toBe(first.data.version);
		});

		it("sees an update", async () => {
			const first = await call("get_issue", { id: issueRef });
			await call("update_issue", { id: issueRef, title: "Renamed" });
			const again = await call("get_issue", { id: issueRef, ifVersion: first.data.version });
			expect(again.data.title).toBe("Renamed");
		});

		it("versions each shape separately", async () => {
			const full = await call("get_issue", { id: issueRef });
			const picked = await call("get_issue", {
				id: issueRef,
				fields: ["title"],
				ifVersion: full.data.version,
			});
			expect(picked.data).toEqual({ title: "Conditional", version: expect.any(String) });
			expect(picked.data.version).not.toBe(full.data.version);
		});

		it("rejects a non-string ifVersion", async () => {
			const { err } = await call("get_issue", { id: issueRef, ifVersion: 7 });
			expect(err).toBeDefined();
		});
	});

	describe("get_wiki_page", () => {
		it("returns {unchanged, version} until the page is verified", async () => {
			const created = await call("create_wiki_page", { title: "Runbook", content: "# Steps" });
			expect(created.err).toBeUndefined();
			const first = await call("get_wiki_page", { slug: created.data.slug });
			const again = await call("get_wiki_page", {
				slug: created.data.slug,
				ifVersion: first.data.version,
			});
			expect(again.data).toEqual({ unchanged: true, version: first.data.version });

			const verified = await call("verify_wiki_page", { slug: created.data.slug });
			expect(verified.err).toBeUndefined();
			const after = await call("get_wiki_page", {
				slug: created.data.slug,
				ifVersion: first.data.version,
			});
			expect(after.data.unchanged).toBeUndefined();
			expect(after.data.content).toContain("verified_at");
		});
	});

	describe("get_playbook", () => {
		it("returns {unchanged, version} for a matching version", async () => {
			const first = await call("get_playbook", { name: "epic-goal" });
			expect(first.data.content.length).toBeGreaterThan(100);
			const again = await call("get_playbook", {
				name: "epic-goal",
				ifVersion: first.data.version,
			});
			expect(again.data).toEqual({ unchanged: true, version: first.data.version });
		});
	});

	describe("list_wiki_changes", () => {
		it("defaults since to the last 7 days", async () => {
			const created = await call("create_wiki_page", { title: "Fresh", content: "x" });
			expect(created.err).toBeUndefined();
			const { err, data } = await call("list_wiki_changes", {});
			expect(err).toBeUndefined();
			expect(JSON.stringify(data)).toContain(created.data.slug);
		});

		it("rejects a malformed cursor", async () => {
			const { err } = await call("list_wiki_changes", { cursor: "not-a-number" });
			expect(err).toBeDefined();
		});
	});
});
