import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedIssue, seedIssueFixture } from "./helpers";

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("File Claims API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;
	let issueId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId, issueId } = await seedIssueFixture());
	});

	async function claimFiles(body: Record<string, unknown>, t = token, s = slug) {
		return SELF.fetch("http://localhost/api/file-claims", {
			method: "POST",
			headers: authHeaders(t, s),
			body: JSON.stringify(body),
		});
	}

	async function releaseFiles(body: Record<string, unknown>, t = token, s = slug) {
		return SELF.fetch("http://localhost/api/file-claims/release", {
			method: "POST",
			headers: authHeaders(t, s),
			body: JSON.stringify(body),
		});
	}

	async function listFileClaims(params: Record<string, string> = {}, t = token, s = slug) {
		const qs = new URLSearchParams(params).toString();
		return SELF.fetch(`http://localhost/api/file-claims${qs ? `?${qs}` : ""}`, {
			headers: authHeaders(t, s),
		});
	}

	// X-Workspace-Slug is required by workspaceMiddleware (reads slug, not path param)
	async function mcpCall(
		method: string,
		args: Record<string, unknown>,
		t = token,
		s = slug,
		wsId = workspaceId
	) {
		return SELF.fetch(`http://localhost/mcp/${wsId}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${t}`,
				"X-Workspace-Slug": s,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: method, arguments: args },
			}),
		});
	}

	// B1: claim_files creates active claims; list_file_claims({issueId}) returns them
	// REST: 3 requests (claim, list, MCP list) — within RATE_LIMIT_API_MAX=5
	it("B1: POST /api/file-claims creates active claims; GET list by issueId returns them", async () => {
		const paths = ["src/foo.ts", "src/bar.ts"];
		const res = await claimFiles({ issueId, paths });
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			created: Array<{ id: string; path: string; releasedAt: null }>;
			overridden: unknown[];
		};
		expect(body.created).toHaveLength(2);
		expect(body.overridden).toHaveLength(0);
		expect(body.created.every((c) => c.releasedAt === null)).toBe(true);
		const returnedPaths = body.created.map((c) => c.path);
		expect(returnedPaths).toContain("src/foo.ts");
		expect(returnedPaths).toContain("src/bar.ts");

		const listRes = await listFileClaims({ issueId });
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as { items: Array<{ path: string }> };
		expect(listBody.items.some((i) => i.path === "src/foo.ts")).toBe(true);
		expect(listBody.items.some((i) => i.path === "src/bar.ts")).toBe(true);

		// Verify via MCP — workspaceMiddleware requires X-Workspace-Slug
		const mcpRes = await mcpCall("list_file_claims", { issueId });
		expect(mcpRes.status).toBe(200);
		const mcpBody = (await mcpRes.json()) as { result: { content: Array<{ text: string }> } };
		const mcpData = JSON.parse(mcpBody.result.content[0].text) as {
			items: Array<{ path: string }>;
		};
		expect(mcpData.items.some((i) => i.path === "src/foo.ts")).toBe(true);
	});

	// B2: conflict on held path (force false) -> 409; batch does NOT partially claim
	// 4 requests (claim, conflict-claim, list other, MCP conflict) — within limit
	it("B2: second claim on held path (force=false) returns 409 naming holder; batch stays atomic", async () => {
		// Claim one path in issue A
		await claimFiles({ issueId, paths: ["src/held.ts"] });

		// Second issue
		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Issue 2" });

		// Try to claim [held, new] — should fail entirely
		const res = await claimFiles({ issueId: issue2.id, paths: ["src/held.ts", "src/other.ts"] });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain(issueId);

		// Assert "src/other.ts" was NOT claimed (batch all-or-nothing)
		const listRes = await listFileClaims({ path: "src/other.ts" });
		const listBody = (await listRes.json()) as { items: Array<{ path: string }> };
		expect(listBody.items).toHaveLength(0);

		// Verify via MCP — should also return -32000 with holder info
		const mcpRes = await mcpCall("claim_files", { issueId: issue2.id, paths: ["src/held.ts"] });
		expect(mcpRes.status).toBe(200);
		const mcpBody = (await mcpRes.json()) as { error?: { code: number; message: string } };
		expect(mcpBody.error?.code).toBe(-32000);
		expect(mcpBody.error?.message).toContain(issueId);
	});

	// B3: force:true steals — prior released, new active, overridden list non-empty
	// 3 requests (claim, force-claim, list) — within limit
	it("B3: force:true releases prior claim and creates new; overridden list contains prior claim", async () => {
		// Claim path in issue A
		await claimFiles({ issueId, paths: ["src/steal.ts"] });

		// Second issue steals it
		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Issue 2" });
		const forceRes = await claimFiles({ issueId: issue2.id, paths: ["src/steal.ts"], force: true });
		expect(forceRes.status).toBe(201);
		const forceBody = (await forceRes.json()) as {
			created: Array<{ issueId: string; path: string; releasedAt: null }>;
			overridden: Array<{ issueId: string; path: string; releasedAt: number }>;
		};
		expect(forceBody.created).toHaveLength(1);
		expect(forceBody.created[0].issueId).toBe(issue2.id);
		expect(forceBody.created[0].releasedAt).toBeNull();
		expect(forceBody.overridden).toHaveLength(1);
		expect(forceBody.overridden[0].issueId).toBe(issueId);
		expect(forceBody.overridden[0].releasedAt).toBeGreaterThan(0);

		// Verify new holder via list
		const listRes = await listFileClaims({ path: "src/steal.ts" });
		const listBody = (await listRes.json()) as { items: Array<{ issueId: string }> };
		expect(listBody.items).toHaveLength(1);
		expect(listBody.items[0].issueId).toBe(issue2.id);
	});

	// B4a: release_files sets released_at; path becomes re-claimable
	// 3 requests (claim, release, re-claim) — within limit
	it("B4a: release_files sets released_at and path becomes re-claimable", async () => {
		await claimFiles({ issueId, paths: ["src/release-me.ts"] });

		const releaseRes = await releaseFiles({ paths: ["src/release-me.ts"], issueId });
		expect(releaseRes.status).toBe(200);
		const releaseBody = (await releaseRes.json()) as {
			released: Array<{ releasedAt: number }>;
			count: number;
		};
		expect(releaseBody.count).toBe(1);
		expect(releaseBody.released[0].releasedAt).toBeGreaterThan(0);

		// Should now be re-claimable
		const reclaimRes = await claimFiles({ issueId, paths: ["src/release-me.ts"] });
		expect(reclaimRes.status).toBe(201);
	});

	// B4b: ending an agent session auto-releases that agent's claims; path becomes re-claimable
	// 5 requests (register-agent, claim, end-agent, list, re-claim) — at limit of 5
	it("B4b: endAgent auto-releases agent file claims; path becomes re-claimable", async () => {
		// Register an agent session
		const agentRes = await SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "test-agent-fc" }),
		});
		expect(agentRes.status).toBe(201);
		const agent = (await agentRes.json()) as { id: string };

		// Claim a file as that agent
		const agentClaimRes = await claimFiles({
			issueId,
			agentId: agent.id,
			paths: ["src/agent-file.ts"],
		});
		expect(agentClaimRes.status).toBe(201);

		// End the agent session — should auto-release claims
		const endRes = await SELF.fetch(`http://localhost/api/agents/${agent.id}/end`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(endRes.status).toBe(200);

		// Claim should now be gone
		const listRes = await listFileClaims({ path: "src/agent-file.ts" });
		const listBody = (await listRes.json()) as { items: Array<unknown> };
		expect(listBody.items).toHaveLength(0);

		// Path is re-claimable
		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "After agent end" });
		const reclaimRes = await claimFiles({ issueId: issue2.id, paths: ["src/agent-file.ts"] });
		expect(reclaimRes.status).toBe(201);
	});

	// B5: list_file_claims({path}) returns holder across issues; tenant isolation
	// 3 requests (claim, list by path, list from other workspace) — within limit
	it("B5: list_file_claims({path}) returns holder; claims in workspace X not visible from workspace Y", async () => {
		await claimFiles({ issueId, paths: ["src/shared.ts"] });

		// List by path — should identify the holder
		const listRes = await listFileClaims({ path: "src/shared.ts" });
		const listBody = (await listRes.json()) as { items: Array<{ issueId: string; path: string }> };
		expect(listBody.items).toHaveLength(1);
		expect(listBody.items[0].issueId).toBe(issueId);
		expect(listBody.items[0].path).toBe("src/shared.ts");

		// Tenant isolation: workspace Y should not see workspace X's claims
		const other = await seedFixture();
		const otherListRes = await listFileClaims({}, other.token, other.workspace.slug);
		expect(otherListRes.status).toBe(200);
		const otherBody = (await otherListRes.json()) as { items: Array<{ issueId: string }> };
		expect(otherBody.items.some((i) => i.issueId === issueId)).toBe(false);
	});
});
