import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedComment, seedIssue, seedProjectFixture, toolError } from "./helpers";

describe("PROJ-998: issue argument aliases (id <-> issueId)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;
	let issueId: string;
	let commentId: string;
	let sessionId: string;

	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
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
		const json = await res.json();
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool results
		const text = (json as any).result?.content?.[0]?.text;
		return { err: toolError(json), data: text ? JSON.parse(text) : undefined };
	}

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "admin" }));
		issueId = (await seedIssue(workspaceId, projectId, userId, { title: "Alias" })).id;
		commentId = (await seedComment(issueId, userId)).id;
		sessionId = (await call("register_agent", { name: "alias-agent" })).data.id;
	});

	const tools: Array<{
		tool: string;
		canonical: "id" | "issueId";
		extra: () => Record<string, unknown>;
	}> = [
		{ tool: "get_issue", canonical: "id", extra: () => ({}) },
		{ tool: "update_issue", canonical: "id", extra: () => ({ title: "Renamed" }) },
		{ tool: "delete_issue", canonical: "id", extra: () => ({}) },
		{ tool: "list_comments", canonical: "issueId", extra: () => ({}) },
		{ tool: "add_comment", canonical: "issueId", extra: () => ({ body: "hi" }) },
		{
			tool: "update_comment",
			canonical: "issueId",
			extra: () => ({ commentId, body: "edited" }),
		},
		{ tool: "delete_comment", canonical: "issueId", extra: () => ({ commentId }) },
		{ tool: "claim_issue", canonical: "issueId", extra: () => ({ agentId: sessionId }) },
		{ tool: "release_issue", canonical: "issueId", extra: () => ({ agentId: sessionId }) },
	];

	for (const { tool, canonical, extra } of tools) {
		const alias = canonical === "id" ? "issueId" : "id";

		it(`${tool}: accepts ${canonical} and its alias ${alias}`, async () => {
			const lease = () => call("claim_issue", { issueId, agentId: sessionId });
			if (tool === "release_issue") await lease();
			const viaCanonical = await call(tool, { [canonical]: issueId, ...extra() });
			expect(viaCanonical.err).toBeUndefined();

			if (tool === "delete_issue") {
				issueId = (await seedIssue(workspaceId, projectId, userId, { title: "Again" })).id;
			}
			if (tool === "delete_comment") commentId = (await seedComment(issueId, userId)).id;
			if (tool === "claim_issue") await call("release_issue", { issueId, agentId: sessionId });
			if (tool === "release_issue") await lease();
			const viaAlias = await call(tool, { [alias]: issueId, ...extra() });
			expect(viaAlias.err).toBeUndefined();
		});

		it(`${tool}: rejects ${canonical} and ${alias} naming different issues`, async () => {
			const other = (await seedIssue(workspaceId, projectId, userId, { title: "Other" })).id;
			const res = await call(tool, { [canonical]: issueId, [alias]: other, ...extra() });
			expect(res.err?.code).toBe("validation");
			expect(res.err?.message).toContain("differ");
		});
	}
});
