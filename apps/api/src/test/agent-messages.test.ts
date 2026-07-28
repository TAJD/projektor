import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedIssue,
	seedIssueFixture,
	seedProject,
	seedToken,
} from "./helpers";

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Agent Messages API", () => {
	// cofferdam-ignore: Refactor.DuplicateBlock: shared seedIssueFixture beforeEach shape, intentional reuse
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;
	let issueId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId, issueId } = await seedIssueFixture());
	});

	async function postMessage(body: Record<string, unknown>, t = token, s = slug) {
		return SELF.fetch("http://localhost/api/agent-messages", {
			method: "POST",
			headers: authHeaders(t, s),
			body: JSON.stringify(body),
		});
	}

	async function listMessages(params: Record<string, string> = {}, t = token, s = slug) {
		const qs = new URLSearchParams(params).toString();
		return SELF.fetch(`http://localhost/api/agent-messages${qs ? `?${qs}` : ""}`, {
			headers: authHeaders(t, s),
		});
	}

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

	// C1: post_message to issue scope; list_messages returns it; cursor pagination stable
	// token: POST×3 (3/5); token2: GET all (1/5) + GET page2 (2/5); token3: GET page1 (1/5); token4: MCP (1/5)
	it("C1: post_message({scope:issue}) and list_messages with cursor pagination (no dupes/gaps)", async () => {
		const scope = `issue:${issueId}`;

		// Post 3 messages so we can page with limit=2
		const r1 = await postMessage({ scope, body: "message one" });
		expect(r1.status).toBe(201);
		const r2 = await postMessage({ scope, body: "message two" });
		expect(r2.status).toBe(201);
		const res3 = await postMessage({ scope, body: "message three" });
		expect(res3.status).toBe(201);
		const msg3 = (await res3.json()) as { id: string; scope: string; body: string };
		expect(msg3.scope).toBe(scope);
		expect(msg3.body).toBe("message three");

		// token2 for list operations — verify all 3 are visible, then grab page 2
		const token2 = await seedToken(workspaceId, userId);

		// Confirm all 3 messages land in the scope before testing pagination
		const allRes = await listMessages({ scope }, token2, slug);
		expect(allRes.status).toBe(200);
		const all = (await allRes.json()) as {
			items: Array<{ body: string }>;
			nextCursor: string | null;
		};
		expect(all.items).toHaveLength(3);

		// token3 for page 1 (fresh budget)
		const token3 = await seedToken(workspaceId, userId);

		// Page 1: limit=2 — composite cursor is "createdAt:id" for same-second stability
		const page1Res = await listMessages({ scope, limit: "2" }, token3, slug);
		expect(page1Res.status).toBe(200);
		const page1 = (await page1Res.json()) as {
			items: Array<{ body: string }>;
			nextCursor: string | null;
		};
		expect(page1.items).toHaveLength(2);
		expect(page1.items[0].body).toBe("message one");
		expect(page1.items[1].body).toBe("message two");
		expect(page1.nextCursor).not.toBeNull();

		// Page 2: cursor from page 1 (uses token2's remaining budget)
		const page2Res = await listMessages(
			{ scope, limit: "2", cursor: page1.nextCursor! },
			token2,
			slug
		);
		expect(page2Res.status).toBe(200);
		const page2 = (await page2Res.json()) as {
			items: Array<{ body: string }>;
			nextCursor: string | null;
		};
		expect(page2.items).toHaveLength(1);
		expect(page2.items[0].body).toBe("message three");
		expect(page2.nextCursor).toBeNull();

		// Verify via MCP
		const token4 = await seedToken(workspaceId, userId);
		const mcpRes = await mcpCall("list_messages", { scope }, token4, slug);
		expect(mcpRes.status).toBe(200);
		const mcpBody = (await mcpRes.json()) as { result: { content: Array<{ text: string }> } };
		const mcpData = JSON.parse(mcpBody.result.content[0].text) as {
			items: Array<{ body: string }>;
		};
		expect(mcpData.items).toHaveLength(3);
	});

	// C2: workspace scope; messages visible via workspace scope; not returned under issue scope
	// 3 requests (post, list workspace scope, list issue scope) — within RATE_LIMIT_API_MAX=5
	it("C2: workspace-scoped post_message visible under workspace scope; not under issue scope", async () => {
		const wsScope = "workspace";
		const issueScope = `issue:${issueId}`;

		const res = await postMessage({ scope: wsScope, body: "workspace-wide notice" });
		expect(res.status).toBe(201);
		const msg = (await res.json()) as { scope: string; body: string };
		expect(msg.scope).toBe(wsScope);

		const token2 = await seedToken(workspaceId, userId);

		// Should appear in workspace channel
		const wsListRes = await listMessages({ scope: wsScope }, token2, slug);
		expect(wsListRes.status).toBe(200);
		const wsBody = (await wsListRes.json()) as { items: Array<{ body: string; scope: string }> };
		expect(wsBody.items.some((m) => m.body === "workspace-wide notice")).toBe(true);

		// Should NOT appear in issue channel
		const issueListRes = await listMessages({ scope: issueScope }, token2, slug);
		expect(issueListRes.status).toBe(200);
		const issueBody = (await issueListRes.json()) as { items: Array<{ body: string }> };
		expect(issueBody.items.some((m) => m.body === "workspace-wide notice")).toBe(false);
	});

	// C3: CAPSTONE — spans agents + file-claims + agent-messages
	// Uses multiple tokens to stay within rate limit (5 per token)
	// cofferdam-ignore: Readability.MaxFunctionLength: capstone test spans multiple API surfaces by design
	it("C3: capstone — two agents coordinate via messages; force-claim posts override notice", async () => {
		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Agent Issue" });
		const scope = `issue:${issue2.id}`;

		// Phase 1 (token): register agents, claim, conflict, post message
		const agent1Res = await mcpCall("register_agent", { name: "agent-one" });
		expect(agent1Res.status).toBe(200);
		const a1Body = (await agent1Res.json()) as { result: { content: Array<{ text: string }> } };
		const agent1 = JSON.parse(a1Body.result.content[0].text) as { id: string };

		const agent2Res = await mcpCall("register_agent", { name: "agent-two" });
		expect(agent2Res.status).toBe(200);
		const a2Body = (await agent2Res.json()) as { result: { content: Array<{ text: string }> } };
		const agent2 = JSON.parse(a2Body.result.content[0].text) as { id: string };

		// agent1 claims path A
		const claimRes = await mcpCall("claim_files", {
			issueId: issue2.id,
			agentId: agent1.id,
			paths: ["src/coord.ts"],
		});
		expect(claimRes.status).toBe(200);
		const claimBody = (await claimRes.json()) as { result: { content: Array<{ text: string }> } };
		expect(JSON.parse(claimBody.result.content[0].text)).toMatchObject({
			created: [{ path: "src/coord.ts" }],
		});

		// agent2 tries to claim path A without force — expect conflict
		const conflictRes = await mcpCall("claim_files", {
			issueId: issue2.id,
			agentId: agent2.id,
			paths: ["src/coord.ts"],
			force: false,
		});
		expect(conflictRes.status).toBe(200);
		const conflictBody = (await conflictRes.json()) as {
			error?: { code: number; message: string };
		};
		expect(conflictBody.error?.code).toBe(-32000);

		// agent2 posts a message to the issue channel
		const postMsgRes = await mcpCall("post_message", {
			scope,
			agentId: agent2.id,
			body: "agent2 needs src/coord.ts — can you release?",
		});
		expect(postMsgRes.status).toBe(200);

		// Phase 2 (token2): agent1 reads the message, releases, agent2 re-claims
		const token2 = await seedToken(workspaceId, userId);

		const readRes = await mcpCall("list_messages", { scope }, token2, slug);
		expect(readRes.status).toBe(200);
		const readBody = (await readRes.json()) as { result: { content: Array<{ text: string }> } };
		const readData = JSON.parse(readBody.result.content[0].text) as {
			items: Array<{ body: string }>;
		};
		expect(readData.items.some((m) => m.body.includes("can you release?"))).toBe(true);

		// agent1 releases path A
		const releaseRes = await mcpCall(
			"release_files",
			{ paths: ["src/coord.ts"], issueId: issue2.id },
			token2,
			slug
		);
		expect(releaseRes.status).toBe(200);

		// agent2 re-claims path A successfully
		const reclaimRes = await mcpCall(
			"claim_files",
			{
				issueId: issue2.id,
				agentId: agent2.id,
				paths: ["src/coord.ts"],
			},
			token2,
			slug
		);
		expect(reclaimRes.status).toBe(200);
		const reclaimBody = (await reclaimRes.json()) as {
			result: { content: Array<{ text: string }> };
		};
		const reclaimData = JSON.parse(reclaimBody.result.content[0].text) as {
			created: Array<{ issueId: string }>;
		};
		expect(reclaimData.created[0].issueId).toBe(issue2.id);

		// agent1 claims path B so agent2 can force-steal it
		const claimBRes = await mcpCall(
			"claim_files",
			{
				issueId: issue2.id,
				agentId: agent1.id,
				paths: ["src/forced.ts"],
			},
			token2,
			slug
		);
		expect(claimBRes.status).toBe(200);

		// Phase 3 (token3): agent2 force-claims path B; assert override notice in list_messages
		const token3 = await seedToken(workspaceId, userId);
		const issue3 = await seedIssue(workspaceId, projectId, userId, { title: "Force Issue" });

		const forceRes = await mcpCall(
			"claim_files",
			{
				issueId: issue3.id,
				agentId: agent2.id,
				paths: ["src/forced.ts"],
				force: true,
			},
			token3,
			slug
		);
		expect(forceRes.status).toBe(200);
		const forceBody = (await forceRes.json()) as { result: { content: Array<{ text: string }> } };
		const forceData = JSON.parse(forceBody.result.content[0].text) as {
			overridden: Array<unknown>;
		};
		expect(forceData.overridden).toHaveLength(1);

		// The force-override notice should appear in the issue3 scope channel (Epic B wiring)
		const noticeScope = `issue:${issue3.id}`;
		const noticeRes = await mcpCall("list_messages", { scope: noticeScope }, token3, slug);
		expect(noticeRes.status).toBe(200);
		const noticeBody = (await noticeRes.json()) as { result: { content: Array<{ text: string }> } };
		const noticeData = JSON.parse(noticeBody.result.content[0].text) as {
			items: Array<{ body: string }>;
		};
		expect(
			noticeData.items.some(
				(m) => m.body.includes("force-claimed") && m.body.includes("src/forced.ts")
			)
		).toBe(true);
	}, 15000); // PROJ-248: many sequential MCP round-trips; full-suite contention pushes this past the 5s default

	// C4: workspace isolation; issue-scope isolation; cursor stability
	// 4 requests (post, list from other ws, post other-issue, list-ws scope) within limit
	it("C4: workspace isolation and issue-scope isolation", async () => {
		const scope = `issue:${issueId}`;

		// Post a message in workspace X
		await postMessage({ scope, body: "workspace-X message" });

		// Workspace Y should not see workspace X's messages
		const other = await seedFixture();
		const otherProject = await seedProject(other.workspace.id);
		const otherIssue = await seedIssue(other.workspace.id, otherProject.id, other.user.id, {
			title: "Other",
		});
		const otherScope = `issue:${otherIssue.id}`;

		// Post in workspace Y's issue scope
		const token2 = await seedToken(workspaceId, userId);
		const otherPostRes = await SELF.fetch("http://localhost/api/agent-messages", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ scope: otherScope, body: "workspace-Y message" }),
		});
		expect(otherPostRes.status).toBe(201);

		// Workspace X cannot see workspace Y messages
		const xListRes = await listMessages({ scope }, token2, slug);
		expect(xListRes.status).toBe(200);
		const xBody = (await xListRes.json()) as { items: Array<{ body: string }> };
		expect(xBody.items.some((m) => m.body === "workspace-Y message")).toBe(false);
		expect(xBody.items.some((m) => m.body === "workspace-X message")).toBe(true);

		// Issue-scope isolation: workspace-channel messages don't bleed into issue scope
		const wsScope = "workspace";
		await postMessage({ scope: wsScope, body: "ws-channel msg" }, token2, slug);

		const token3 = await seedToken(workspaceId, userId);
		const isoRes = await listMessages({ scope }, token3, slug);
		expect(isoRes.status).toBe(200);
		const isoBody = (await isoRes.json()) as { items: Array<{ body: string }> };
		expect(isoBody.items.some((m) => m.body === "ws-channel msg")).toBe(false);
	});
});
