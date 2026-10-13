import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedAgentLease,
	seedFixture,
	seedGroupGrant,
	seedIssue,
	seedIssueFixture,
	seedProject,
	seedToken,
	seedWorkspaceRoles,
	toolError,
} from "./helpers";

describe("Agent Messages API", () => {
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

		// PROJ-920: MCP paging round-trip — page 1's nextCursor (a "createdAt:id" string)
		// must be accepted back by the argument validator.
		const token5 = await seedToken(workspaceId, userId);
		const p1Res = await mcpCall("list_messages", { scope, limit: 2 }, token5, slug);
		const p1Body = (await p1Res.json()) as { result: { content: Array<{ text: string }> } };
		const p1 = JSON.parse(p1Body.result.content[0].text) as { nextCursor: string | null };
		expect(typeof p1.nextCursor).toBe("string");
		const p2Res = await mcpCall(
			"list_messages",
			{ scope, limit: 2, cursor: p1.nextCursor },
			token5,
			slug
		);
		const p2Body = (await p2Res.json()) as {
			result?: { content: Array<{ text: string }> };
			error?: { message: string };
		};
		expect(p2Body.error).toBeUndefined();
		const p2 = JSON.parse(p2Body.result?.content[0].text ?? "{}") as {
			items: Array<{ body: string }>;
		};
		expect(p2.items.map((m) => m.body)).toEqual(["message one"]);
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
		const conflictBody = (await conflictRes.json()) as { error?: unknown };
		expect(conflictBody.error).toBeUndefined();
		expect(toolError(conflictBody)?.code).toBe("conflict");

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
				verbose: true,
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
		await seedGroupGrant(other.workspace.id, other.user.id, otherProject.id, "member");
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

	// --- Heartbeat refresh on a live agentId (PROJ-929) ---

	async function heartbeatOf(id: string): Promise<number> {
		const row = await env.DB.prepare("SELECT last_heartbeat_at FROM agent_sessions WHERE id = ?")
			.bind(id)
			.first<{ last_heartbeat_at: number }>();
		return row!.last_heartbeat_at;
	}

	it("post_message refreshes a live agentId's heartbeat, but never revives a stale one", async () => {
		const { agentSessionId: live } = await seedAgentLease(workspaceId, issueId);
		const backdated = Math.floor(Date.now() / 1000) - 10;
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(backdated, live)
			.run();

		const res = await postMessage({ scope: `issue:${issueId}`, agentId: live, body: "still here" });
		expect(res.status).toBe(201);
		expect(await heartbeatOf(live)).toBeGreaterThan(backdated);

		const { agentSessionId: dead } = await seedAgentLease(workspaceId, issueId, { live: false });
		const deadBefore = await heartbeatOf(dead);

		const res2 = await postMessage({
			scope: `issue:${issueId}`,
			agentId: dead,
			body: "ghost post",
		});
		expect(res2.status).toBe(201);
		expect(await heartbeatOf(dead)).toBe(deadBefore);
	});
});

describe("Agent messages: default scope, project channels, newest-first reads (PROJ-1008)", () => {
	type Principal = { user: { id: string } };
	type Project = { id: string; key: string };
	type Posted = { id: string; scope: string; createdAt: number };
	type Page = {
		items: Array<Record<string, unknown> & { id: string; body: string }>;
		nextCursor: string | null;
	};

	let ws: Awaited<ReturnType<typeof seedWorkspaceRoles>>;
	let visible: Project;
	let hidden: Project;
	let visibleIssue: { id: string; number: number };
	let idPrefix: string;

	beforeEach(async () => {
		idPrefix = `${crypto.randomUUID().slice(0, 8)}-`;
		ws = await seedWorkspaceRoles();
		visible = await seedProject(ws.workspace.id, "VIS");
		hidden = await seedProject(ws.workspace.id, "HID");
		await seedGroupGrant(ws.workspace.id, ws.member.user.id, visible.id, "member");
		visibleIssue = await seedIssue(ws.workspace.id, visible.id, ws.owner.user.id);
	});

	async function tool<T = Record<string, unknown>>(
		name: string,
		args: Record<string, unknown>,
		who: Principal = ws.owner
	) {
		const token = await seedToken(ws.workspace.id, who.user.id);
		const res = await SELF.fetch(`http://localhost/mcp/${ws.workspace.id}`, {
			method: "POST",
			headers: authHeaders(token, ws.workspace.slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
		const err = toolError(json);
		return { err, data: (err ? {} : JSON.parse(json.result.content[0].text)) as T };
	}

	async function rest(path: string, who: Principal = ws.owner, init: RequestInit = {}) {
		const token = await seedToken(ws.workspace.id, who.user.id);
		return SELF.fetch(`http://localhost/api/agent-messages${path}`, {
			...init,
			headers: authHeaders(token, ws.workspace.slug),
		});
	}

	async function seedMessages(
		scope: string,
		rows: ReadonlyArray<{ id: string; createdAt: number; agentId?: string }>
	) {
		await env.DB.batch(
			rows.map((r) =>
				env.DB.prepare(
					"INSERT INTO agent_messages (id, workspace_id, scope, agent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
				).bind(
					`${idPrefix}${r.id}`,
					ws.workspace.id,
					scope,
					r.agentId ?? null,
					`body ${r.id}`,
					r.createdAt
				)
			)
		);
	}

	const ids = (page: { data: Page }) => page.data.items.map((m) => m.id.replace(idPrefix, ""));
	const bodies = (page: { data: Page }) => page.data.items.map((m) => m.body);

	const projectSpellings: Array<[string, (p: Project) => Record<string, unknown>]> = [
		["scope:project + projectId uuid", (p) => ({ scope: "project", projectId: p.id })],
		["scope:project + projectId key", (p) => ({ scope: "project", projectId: p.key })],
		["project:<uuid>", (p) => ({ scope: `project:${p.id}` })],
		["project:<key>", (p) => ({ scope: `project:${p.key}` })],
		["projectId alone", (p) => ({ projectId: p.id })],
	];

	describe("scope defaults", () => {
		it("posts to the workspace channel when scope is omitted, and reads it back the same way", async () => {
			const posted = await tool<Posted>("post_message", { body: "fleet notice" });
			expect(posted.err).toBeUndefined();
			expect(posted.data.scope).toBe("workspace");

			const list = await tool<Page>("list_messages", {});
			expect(list.err).toBeUndefined();
			expect(bodies(list)).toEqual(["fleet notice"]);
		});

		it("reads a bare issue UUID or ref as issue:<that>", async () => {
			const ref = `${visible.key}-${visibleIssue.number}`;
			const canonical = `issue:${visibleIssue.id}`;

			const byUuid = await tool<Posted>("post_message", {
				scope: visibleIssue.id,
				body: "by uuid",
			});
			const byRef = await tool<Posted>("post_message", { scope: ref, body: "by ref" });
			expect(byUuid.data.scope).toBe(canonical);
			expect(byRef.data.scope).toBe(canonical);

			for (const scope of [canonical, visibleIssue.id, ref]) {
				const list = await tool<Page>("list_messages", { scope, order: "asc" });
				expect(bodies(list)).toEqual(["by uuid", "by ref"]);
			}
		});

		it("answers a bare ref to a hidden issue like an unknown one", async () => {
			const hiddenIssue = await seedIssue(ws.workspace.id, hidden.id, ws.owner.user.id);
			const hiddenRef = await tool(
				"post_message",
				{ scope: `${hidden.key}-${hiddenIssue.number}`, body: "x" },
				ws.member
			);
			const unknownRef = await tool("post_message", { scope: "HID-9999", body: "x" }, ws.member);
			expect(hiddenRef.err?.code).toBe("not_found");
			expect(hiddenRef.err?.message).toBe(unknownRef.err?.message);
		});
	});

	describe("project channels", () => {
		it.each(projectSpellings)("stores %s as project:<uuid>", async (_name, spelling) => {
			const posted = await tool<Posted>("post_message", { ...spelling(visible), body: "note" });
			expect(posted.err).toBeUndefined();
			expect(posted.data.scope).toBe(`project:${visible.id}`);
		});

		it("lists a project channel under every spelling of its scope", async () => {
			await tool("post_message", { scope: "project", projectId: visible.id, body: "project note" });
			for (const [, spelling] of projectSpellings) {
				const list = await tool<Page>("list_messages", spelling(visible));
				expect(list.err).toBeUndefined();
				expect(bodies(list)).toEqual(["project note"]);
			}
		});

		it('rejects scope:"project" without a projectId, naming the field', async () => {
			const post = await tool("post_message", { scope: "project", body: "x" });
			expect(post.err?.code).toBe("validation");
			expect(post.err?.fields?.projectId).toBeDefined();

			const list = await tool("list_messages", { scope: "project" });
			expect(list.err?.code).toBe("validation");
			expect(list.err?.fields?.projectId).toBeDefined();
		});

		it("rejects a projectId that contradicts a non-project scope", async () => {
			for (const scope of ["workspace", `issue:${visibleIssue.id}`, `project:${visible.key}`]) {
				const post = await tool("post_message", { scope, projectId: visible.id, body: "x" });
				expect(post.err?.code).toBe("validation");
				expect(post.err?.fields?.projectId).toBeDefined();
			}
		});

		it("keeps the project, workspace and issue channels apart", async () => {
			await tool("post_message", { body: "workspace msg" });
			await tool("post_message", { scope: `issue:${visibleIssue.id}`, body: "issue msg" });
			await tool("post_message", { scope: "project", projectId: visible.id, body: "project msg" });
			await tool("post_message", { scope: "project", projectId: hidden.id, body: "other project" });

			expect(bodies(await tool<Page>("list_messages", {}))).toEqual(["workspace msg"]);
			expect(
				bodies(await tool<Page>("list_messages", { scope: `issue:${visibleIssue.id}` }))
			).toEqual(["issue msg"]);
			expect(
				bodies(await tool<Page>("list_messages", { scope: "project", projectId: visible.id }))
			).toEqual(["project msg"]);
			expect(
				bodies(await tool<Page>("list_messages", { scope: "project", projectId: hidden.id }))
			).toEqual(["other project"]);
		});
	});

	describe("project channel visibility", () => {
		it("lets a member with a grant post to and read the channel", async () => {
			const posted = await tool<Posted>(
				"post_message",
				{ scope: "project", projectId: visible.id, body: "from member" },
				ws.member
			);
			expect(posted.err).toBeUndefined();

			const list = await tool<Page>(
				"list_messages",
				{ scope: `project:${visible.key}` },
				ws.member
			);
			expect(bodies(list)).toEqual(["from member"]);
		});

		it("hides a project the member has no grant on: posting 404s like an unknown project, reading is empty", async () => {
			const secret = await tool("post_message", { scope: `project:${hidden.id}`, body: "secret" });
			expect(secret.err).toBeUndefined();

			for (const spelling of [
				{ scope: "project", projectId: hidden.id },
				{ scope: `project:${hidden.key}` },
			]) {
				const hiddenPost = await tool("post_message", { ...spelling, body: "probe" }, ws.member);
				const unknownPost = await tool(
					"post_message",
					{ scope: `project:${crypto.randomUUID()}`, body: "probe" },
					ws.member
				);
				expect(hiddenPost.err?.code).toBe("not_found");
				expect(hiddenPost.err?.message).toBe(unknownPost.err?.message);

				const memberList = await tool<Page>("list_messages", spelling, ws.member);
				expect(memberList.err).toBeUndefined();
				expect(memberList.data.items).toEqual([]);
			}

			const ownerList = await tool<Page>("list_messages", {
				scope: "project",
				projectId: hidden.id,
			});
			expect(bodies(ownerList)).toEqual(["secret"]);
		});

		it("does not reach a project in another workspace, even for an owner", async () => {
			const other = await seedFixture();
			const otherProject = await seedProject(other.workspace.id, "OTH");

			const post = await tool("post_message", { scope: `project:${otherProject.id}`, body: "x" });
			expect(post.err?.code).toBe("not_found");

			const list = await tool<Page>("list_messages", { scope: `project:${otherProject.id}` });
			expect(list.err).toBeUndefined();
			expect(list.data.items).toEqual([]);
		});

		it("applies the same rules over REST", async () => {
			const posted = await rest("", ws.member, {
				method: "POST",
				body: JSON.stringify({ scope: "project", projectId: visible.id, body: "rest note" }),
			});
			expect(posted.status).toBe(201);
			expect(((await posted.json()) as Posted).scope).toBe(`project:${visible.id}`);

			const denied = await rest("", ws.member, {
				method: "POST",
				body: JSON.stringify({ scope: `project:${hidden.key}`, body: "x" }),
			});
			expect(denied.status).toBe(404);

			const list = await rest(`?scope=project&projectId=${visible.id}`, ws.member);
			expect(list.status).toBe(200);
			expect(((await list.json()) as Page).items.map((m) => m.body)).toEqual(["rest note"]);
		});
	});

	describe("MCP response shape", () => {
		it("post_message returns only {id, scope, createdAt}; verbose:true returns the row", async () => {
			const slim = await tool<Posted>("post_message", { body: "hello" });
			expect(Object.keys(slim.data).sort()).toEqual(["createdAt", "id", "scope"]);
			expect(slim.data.scope).toBe("workspace");
			expect(slim.data.createdAt).toEqual(expect.any(Number));

			const raw = await tool("post_message", { body: "hello again", verbose: true });
			expect(raw.data).toMatchObject({
				workspaceId: ws.workspace.id,
				scope: "workspace",
				agentId: null,
				body: "hello again",
			});
		});

		it("list_messages rows drop workspaceId and null keys; verbose:true returns the raw rows", async () => {
			await seedMessages("workspace", [{ id: "m1", createdAt: 1000 }]);

			const slim = await tool<Page>("list_messages", {});
			expect(Object.keys(slim.data.items[0]).sort()).toEqual(["body", "createdAt", "id", "scope"]);

			const raw = await tool<Page>("list_messages", { verbose: true });
			expect(raw.data.items[0]).toMatchObject({ workspaceId: ws.workspace.id, agentId: null });
		});

		it("list_messages keeps agentId when a session posted the message", async () => {
			const { agentSessionId } = await seedAgentLease(ws.workspace.id, visibleIssue.id);
			await seedMessages("workspace", [{ id: "m1", createdAt: 1000, agentId: agentSessionId }]);

			const list = await tool<Page>("list_messages", {});
			expect(list.data.items[0].agentId).toBe(agentSessionId);
		});
	});

	describe("list_messages order, window and paging", () => {
		it("defaults to newest first and 20 rows over MCP", async () => {
			const pad = (i: number) => `m${String(i).padStart(2, "0")}`;
			await seedMessages(
				"workspace",
				Array.from({ length: 25 }, (_, i) => ({ id: pad(i), createdAt: 1000 + i }))
			);

			const page = await tool<Page>("list_messages", {});
			expect(ids(page)).toEqual(Array.from({ length: 20 }, (_, i) => pad(24 - i)));
			expect(page.data.nextCursor).not.toBeNull();

			const wide = await tool<Page>("list_messages", { limit: 25 });
			expect(wide.data.items).toHaveLength(25);
		});

		it('returns oldest first for order:"asc"', async () => {
			await seedMessages("workspace", [
				{ id: "m1", createdAt: 1000 },
				{ id: "m2", createdAt: 2000 },
				{ id: "m3", createdAt: 3000 },
			]);
			expect(ids(await tool<Page>("list_messages", { order: "asc" }))).toEqual(["m1", "m2", "m3"]);
			expect(ids(await tool<Page>("list_messages", { order: "desc" }))).toEqual(["m3", "m2", "m1"]);
		});

		it("since (unix seconds) keeps messages created at or after it", async () => {
			await seedMessages("workspace", [
				{ id: "old", createdAt: 1_700_000_100_000 },
				{ id: "edge", createdAt: 1_700_000_200_000 },
				{ id: "new", createdAt: 1_700_000_300_500 },
			]);

			expect(ids(await tool<Page>("list_messages", { since: 1_700_000_200 }))).toEqual([
				"new",
				"edge",
			]);
			expect(ids(await tool<Page>("list_messages", { since: 1_700_000_301 }))).toEqual([]);
		});

		it.each([
			["desc", ["m3", "m2c", "m2b", "m2a", "m1"]],
			["asc", ["m1", "m2a", "m2b", "m2c", "m3"]],
		] as const)(
			"pages through ties on createdAt without gaps or repeats, %s",
			async (order, expected) => {
				await seedMessages("workspace", [
					{ id: "m1", createdAt: 1000 },
					{ id: "m2a", createdAt: 2000 },
					{ id: "m2b", createdAt: 2000 },
					{ id: "m2c", createdAt: 2000 },
					{ id: "m3", createdAt: 3000 },
				]);

				const seen: string[] = [];
				let cursor: string | undefined;
				for (let i = 0; i < 4; i++) {
					const page = await tool<Page>("list_messages", {
						order,
						limit: 2,
						...(cursor ? { cursor } : {}),
					});
					seen.push(...ids(page));
					if (!page.data.nextCursor) break;
					cursor = page.data.nextCursor;
				}
				expect(seen).toEqual(expected);
			}
		);

		it("keeps REST oldest-first with the full row, and accepts order and since", async () => {
			await seedMessages("workspace", [
				{ id: "m1", createdAt: 1_700_000_100_000 },
				{ id: "m2", createdAt: 1_700_000_200_000 },
			]);

			const restIds = async (path: string) =>
				ids({ data: (await (await rest(path)).json()) as Page });

			const asc = (await (await rest("?scope=workspace")).json()) as Page;
			expect(ids({ data: asc })).toEqual(["m1", "m2"]);
			expect(asc.items[0]).toMatchObject({
				workspaceId: ws.workspace.id,
				scope: "workspace",
				agentId: null,
			});

			expect(await restIds("?order=desc")).toEqual(["m2", "m1"]);
			expect(await restIds("?since=1700000200")).toEqual(["m2"]);
		});
	});
});
