import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWork as startWorkDirect } from "../services/agents";
import type { ServiceCtx } from "../services/types";
import { authHeaders, seedFixture, seedIssue, seedProjectFixture } from "./helpers";

describe("Agents API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture());
	});

	async function registerAgent(body: Record<string, unknown>) {
		return SELF.fetch("http://localhost/api/agents", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify(body),
		});
	}

	// A1: register -> active, appears in list_active_agents by issueId
	it("A1: POST /api/agents registers a session and it appears in GET list filtered by issueId", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "Test Issue" });

		const res = await registerAgent({ name: "test-agent", issueId: issue.id });
		expect(res.status).toBe(201);
		const session = (await res.json()) as { id: string; status: string };
		expect(session.id).toBeTruthy();
		expect(session.status).toBe("active");

		const listRes = await SELF.fetch(`http://localhost/api/agents?issueId=${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		expect(listRes.status).toBe(200);
		const body = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(body.items.some((s) => s.id === session.id)).toBe(true);
	});

	// A2: heartbeat bumps last_heartbeat_at; stale session excluded from list
	it("A2: heartbeat updates last_heartbeat_at; stale session is excluded from list", async () => {
		const res = await registerAgent({ name: "heartbeat-agent" });
		expect(res.status).toBe(201);
		const session = (await res.json()) as { id: string };

		// Heartbeat should succeed
		const hbRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/heartbeat`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(hbRes.status).toBe(200);
		const updated = (await hbRes.json()) as { lastHeartbeatAt: number };
		expect(typeof updated.lastHeartbeatAt).toBe("number");

		// Backdate the heartbeat to simulate staleness (> 120s ago)
		const stale = Math.floor(Date.now() / 1000) - 200;
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(stale, session.id)
			.run();

		// Should now be excluded from active list
		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(listBody.items.some((s) => s.id === session.id)).toBe(false);
	});

	// A3: end -> status='ended', excluded from active list
	it("A3: POST /:id/end sets status=ended and excludes session from active list", async () => {
		const res = await registerAgent({ name: "end-agent" });
		expect(res.status).toBe(201);
		const session = (await res.json()) as { id: string };

		const endRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/end`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(endRes.status).toBe(200);
		const ended = (await endRes.json()) as { status: string; endedAt: number | null };
		expect(ended.status).toBe("ended");
		expect(ended.endedAt).toBeGreaterThan(0);

		// Must not appear in active list
		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(listBody.items.some((s) => s.id === session.id)).toBe(false);
	});

	// A4 (PROJ-336): kind is deprecated — still accepted for MCP compatibility but
	// ignored, and no longer present in register/list responses as a trust signal.
	it("A4: caller-supplied kind is accepted but ignored, and absent from responses", async () => {
		const agentRes = await registerAgent({ name: "bot" });
		const agentSession = (await agentRes.json()) as Record<string, unknown>;
		expect(agentSession.kind).toBeUndefined();

		const humanRes = await registerAgent({ name: "human-user", kind: "human" });
		expect(humanRes.status).toBe(201);
		const humanSession = (await humanRes.json()) as { id: string } & Record<string, unknown>;
		expect(humanSession.kind).toBeUndefined();

		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		const listBody = (await listRes.json()) as { items: Array<Record<string, unknown>> };
		const humanItem = listBody.items.find((s) => s.id === humanSession.id);
		expect(humanItem).toBeDefined();
		expect(humanItem?.kind).toBeUndefined();
	});

	// A5: tenant isolation
	it("A5: session in workspace X is not visible from workspace Y; heartbeat/end from Y -> 404", async () => {
		const other = await seedFixture();

		// Register session in our workspace (X)
		const res = await registerAgent({ name: "isolated-agent" });
		const session = (await res.json()) as { id: string };

		// Workspace Y should not see it
		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
		expect(listBody.items.some((s) => s.id === session.id)).toBe(false);

		// Heartbeat from Y -> 404
		const hbRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/heartbeat`, {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(hbRes.status).toBe(404);

		// End from Y -> 404
		const endRes = await SELF.fetch(`http://localhost/api/agents/${session.id}/end`, {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(endRes.status).toBe(404);
	});

	it("POST /api/agents returns 400 for missing name", async () => {
		const res = await registerAgent({});
		expect(res.status).toBe(400);
	});

	it("POST /api/agents returns 404 for unknown issueId", async () => {
		const res = await registerAgent({ name: "orphan", issueId: crypto.randomUUID() });
		expect(res.status).toBe(404);
	});

	it("POST /:id/heartbeat returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/agents/${crypto.randomUUID()}/heartbeat`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("POST /:id/end returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/agents/${crypto.randomUUID()}/end`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("GET /api/agents returns all active sessions in workspace", async () => {
		await registerAgent({ name: "agent-1" });
		await registerAgent({ name: "agent-2" });

		const listRes = await SELF.fetch("http://localhost/api/agents", {
			headers: authHeaders(token, slug),
		});
		const body = (await listRes.json()) as { items: Array<{ name: string }> };
		const names = body.items.map((s) => s.name);
		expect(names).toContain("agent-1");
		expect(names).toContain("agent-2");
	});

	// PROJ-929: start_work / finish_work replace the 5-call fleet routine.
	describe("PROJ-929: start_work / finish_work", () => {
		function startWork(body: Record<string, unknown>) {
			return SELF.fetch("http://localhost/api/agents/start-work", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify(body),
			});
		}

		function finishWork(body: Record<string, unknown>) {
			return SELF.fetch("http://localhost/api/agents/finish-work", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify(body),
			});
		}

		async function mcpCall(name: string, args: Record<string, unknown>) {
			const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"X-Workspace-Slug": slug,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
			const body = (await res.json()) as {
				result?: { content: Array<{ text: string }>; isError?: boolean };
				error?: { message: string };
			};
			return { status: res.status, body };
		}

		it("registers, claims the issue and files, and posts a start message in one call", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Start work" });

			const res = await startWork({
				issue: issue.id,
				paths: ["src/a.ts", "src/b.ts"],
				name: "worker-1",
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				sessionId: string;
				lease: { issueId: string };
				claimedFiles: Array<{ path: string }>;
			};
			expect(body.sessionId).toBeTruthy();
			expect(body.lease.issueId).toBe(issue.id);
			expect(body.claimedFiles.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);

			const leaseRow = await env.DB.prepare(
				"SELECT agent_session_id FROM issue_leases WHERE issue_id = ? AND released_at IS NULL"
			)
				.bind(issue.id)
				.first<{ agent_session_id: string }>();
			expect(leaseRow?.agent_session_id).toBe(body.sessionId);

			const messages = await env.DB.prepare("SELECT body FROM agent_messages WHERE scope = ?")
				.bind(`issue:${issue.id}`)
				.all<{ body: string }>();
			expect(messages.results.some((m) => m.body.includes("started work"))).toBe(true);
		});

		it("works with no paths given", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "No paths" });
			const res = await startWork({ issue: issue.id, name: "worker-1" });
			expect(res.status).toBe(201);
			const body = (await res.json()) as { claimedFiles: unknown[] };
			expect(body.claimedFiles).toEqual([]);
		});

		it("is all-or-nothing: a lease conflict leaves no session, lease, or claim behind", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Contended" });
			const first = await startWork({ issue: issue.id, name: "worker-1" });
			expect(first.status).toBe(201);

			const second = await startWork({
				issue: issue.id,
				paths: ["src/never-claimed.ts"],
				name: "worker-2",
			});
			expect(second.status).toBe(409); // Same ConflictError as claim_issue today

			const sessions = await env.DB.prepare(
				"SELECT id, status FROM agent_sessions WHERE name = 'worker-2'"
			).all<{ id: string; status: string }>();
			// The session was registered internally, then compensated — either absent, or
			// present but already ended, never left active.
			for (const s of sessions.results) {
				expect(s.status).toBe("ended");
			}

			const claim = await env.DB.prepare("SELECT id FROM issue_file_claims WHERE path = ?")
				.bind("src/never-claimed.ts")
				.first();
			expect(claim).toBeNull();
		});

		// PROJ-929 review fix-up: the compensating endAgent() in startWork's catch block must
		// not let its own failure hide the original error, or silently crash the request.
		describe("compensating endAgent failure is isolated (PROJ-929 fix-up)", () => {
			afterEach(() => {
				vi.restoreAllMocks();
			});

			it("rethrows the original conflict error even when the compensating endAgent call itself fails", async () => {
				const issue1 = await seedIssue(workspaceId, projectId, userId, { title: "Holds file" });
				const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Wants file" });
				await startWorkDirect(
					{ db: env.DB, kv: env.KV, r2: env.R2, workspaceId, userId, role: "owner" } as ServiceCtx,
					{ issue: issue1.id, paths: ["src/contended.ts"], name: "holder" }
				);

				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
				const origPrepare = env.DB.prepare.bind(env.DB);
				vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
					const stmt = origPrepare(sql);
					// Simulate a D1 outage specifically for endAgent's own status='ended' update
					// (its bind args carry "ended" as the new status), leaving every other query —
					// including the earlier successful claimIssue/claimFiles calls — untouched.
					if (/update .*agent_sessions/i.test(sql)) {
						const origBind = stmt.bind.bind(stmt);
						return {
							...stmt,
							bind: (...args: unknown[]) => {
								if (args.includes("ended")) {
									throw new Error("simulated D1 outage during compensating endAgent");
								}
								return origBind(...args);
							},
						} as D1PreparedStatement;
					}
					return stmt;
				});

				const ctx: ServiceCtx = {
					db: env.DB,
					kv: env.KV,
					r2: env.R2,
					workspaceId,
					userId,
					role: "owner",
				} as ServiceCtx;

				await expect(
					startWorkDirect(ctx, {
						issue: issue2.id,
						paths: ["src/contended.ts"],
						name: "wants-it",
					})
				).rejects.toMatchObject({ kind: "conflict" });

				// The compensating-cleanup failure was logged, not thrown or swallowed silently.
				expect(errorSpy).toHaveBeenCalled();
			});
		});

		it("is all-or-nothing: a file-claim conflict releases the lease it just took", async () => {
			const issue1 = await seedIssue(workspaceId, projectId, userId, { title: "Holds file" });
			const heldRes = await startWork({
				issue: issue1.id,
				paths: ["src/contended.ts"],
				name: "holder",
			});
			expect(heldRes.status).toBe(201);

			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Wants file" });
			const res = await startWork({
				issue: issue2.id,
				paths: ["src/contended.ts"],
				name: "wants-it",
			});
			expect(res.status).toBe(409); // Same ConflictError as claim_files today

			// issue2 never ended up with a live lease — the failed file claim rolled it back.
			const lease = await env.DB.prepare(
				"SELECT id FROM issue_leases WHERE issue_id = ? AND released_at IS NULL"
			)
				.bind(issue2.id)
				.first();
			expect(lease).toBeNull();
		});

		it("finish_work transitions the issue, releases everything, and ends the session", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Finish" });
			const started = await startWork({ issue: issue.id, paths: ["src/finish.ts"], name: "w" });
			const { sessionId } = (await started.json()) as { sessionId: string };

			const res = await finishWork({
				sessionId,
				issue: issue.id,
				status: "done",
				completionReport: { summary: "Done", verification: "pnpm test" },
			});
			expect(res.status).toBe(200);

			const issueRow = await env.DB.prepare("SELECT status FROM issues WHERE id = ?")
				.bind(issue.id)
				.first<{ status: string }>();
			expect(issueRow?.status).toBe("done");

			const lease = await env.DB.prepare(
				"SELECT id FROM issue_leases WHERE issue_id = ? AND released_at IS NULL"
			)
				.bind(issue.id)
				.first();
			expect(lease).toBeNull();

			const claim = await env.DB.prepare(
				"SELECT id FROM issue_file_claims WHERE issue_id = ? AND released_at IS NULL"
			)
				.bind(issue.id)
				.first();
			expect(claim).toBeNull();

			const session = await env.DB.prepare("SELECT status FROM agent_sessions WHERE id = ?")
				.bind(sessionId)
				.first<{ status: string }>();
			expect(session?.status).toBe("ended");
		});

		it("finish_work with no status/completionReport just releases and ends the session", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "No transition" });
			const started = await startWork({ issue: issue.id, name: "w" });
			const { sessionId } = (await started.json()) as { sessionId: string };

			const res = await finishWork({ sessionId, issue: issue.id });
			expect(res.status).toBe(200);

			const issueRow = await env.DB.prepare("SELECT status FROM issues WHERE id = ?")
				.bind(issue.id)
				.first<{ status: string }>();
			expect(issueRow?.status).toBe("backlog"); // unchanged

			const session = await env.DB.prepare("SELECT status FROM agent_sessions WHERE id = ?")
				.bind(sessionId)
				.first<{ status: string }>();
			expect(session?.status).toBe("ended");
		});

		it("claim_issue (via start_work) refreshes the session's heartbeat", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Heartbeat" });
			const before = Math.floor(Date.now() / 1000) - 100;

			const res = await startWork({ issue: issue.id, name: "w" });
			const { sessionId } = (await res.json()) as { sessionId: string };

			const session = await env.DB.prepare(
				"SELECT last_heartbeat_at FROM agent_sessions WHERE id = ?"
			)
				.bind(sessionId)
				.first<{ last_heartbeat_at: number }>();
			expect(session?.last_heartbeat_at).toBeGreaterThanOrEqual(before);
		});

		it("MCP parity: start_work and finish_work work the same over MCP", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "MCP path" });

			const started = await mcpCall("start_work", { issue: issue.id, name: "mcp-worker" });
			expect(started.status).toBe(200);
			const startedResult = JSON.parse(started.body.result?.content[0].text ?? "{}") as {
				sessionId: string;
			};
			expect(startedResult.sessionId).toBeTruthy();

			const finished = await mcpCall("finish_work", {
				sessionId: startedResult.sessionId,
				issue: issue.id,
				status: "cancelled",
			});
			expect(finished.status).toBe(200);
			expect(finished.body.result?.isError).toBeFalsy();

			const issueRow = await env.DB.prepare("SELECT status FROM issues WHERE id = ?")
				.bind(issue.id)
				.first<{ status: string }>();
			expect(issueRow?.status).toBe("cancelled");
		});

		it("the old tools still work standalone (register_agent/claim_issue/release_issue/end_agent)", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Old path" });
			const reg = await registerAgent({ name: "old-style" });
			const { id: agentId } = (await reg.json()) as { id: string };

			const claim = await SELF.fetch(`http://localhost/api/issues/${issue.id}/claim`, {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ agentId }),
			});
			expect(claim.status).toBe(201);

			const end = await SELF.fetch(`http://localhost/api/agents/${agentId}/end`, {
				method: "POST",
				headers: authHeaders(token, slug),
			});
			expect(end.status).toBe(200);
		});
	});

	// PROJ-932: list_active_agents defaults to live entries only; includeStale restores
	// the old unfiltered listing (ended and stale sessions included); projectId scopes to
	// one project (key or uuid) via the linked issue; every linked item carries issueRef.
	describe("PROJ-932: live-only default, includeStale, projectId, issueRef", () => {
		const projectKey = "PROJ"; // seedProject's default key

		function backdateHeartbeat(agentId: string, secondsAgo = 200) {
			const stale = Math.floor(Date.now() / 1000) - secondsAgo;
			return env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
				.bind(stale, agentId)
				.run();
		}

		async function listAgents(params: Record<string, string> = {}) {
			const qs = new URLSearchParams(params).toString();
			return SELF.fetch(`http://localhost/api/agents${qs ? `?${qs}` : ""}`, {
				headers: authHeaders(token, slug),
			});
		}

		it("excludes a session with a stale heartbeat by default; includeStale:true includes it", async () => {
			const res = await registerAgent({ name: "stale-agent-932" });
			const session = (await res.json()) as { id: string };
			await backdateHeartbeat(session.id);

			const withoutFlag = await listAgents();
			const withoutBody = (await withoutFlag.json()) as { items: Array<{ id: string }> };
			expect(withoutBody.items.some((s) => s.id === session.id)).toBe(false);

			const withFlag = await listAgents({ includeStale: "true" });
			const withBody = (await withFlag.json()) as { items: Array<{ id: string }> };
			expect(withBody.items.some((s) => s.id === session.id)).toBe(true);
		});

		it("excludes an ended session by default; includeStale:true includes it", async () => {
			const res = await registerAgent({ name: "ended-agent-932" });
			const session = (await res.json()) as { id: string };
			await SELF.fetch(`http://localhost/api/agents/${session.id}/end`, {
				method: "POST",
				headers: authHeaders(token, slug),
			});

			const withoutFlag = await listAgents();
			const withoutBody = (await withoutFlag.json()) as { items: Array<{ id: string }> };
			expect(withoutBody.items.some((s) => s.id === session.id)).toBe(false);

			const withFlag = await listAgents({ includeStale: "true" });
			const withBody = (await withFlag.json()) as { items: Array<{ id: string }> };
			expect(withBody.items.some((s) => s.id === session.id)).toBe(true);
		});

		it("carries the linked issue's issueRef; null when unlinked", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Linked" });
			const linked = await registerAgent({ name: "linked-932", issueId: issue.id });
			const linkedSession = (await linked.json()) as { id: string };
			const unlinked = await registerAgent({ name: "unlinked-932" });
			const unlinkedSession = (await unlinked.json()) as { id: string };

			const res = await listAgents();
			const body = (await res.json()) as {
				items: Array<{ id: string; issueRef: string | null }>;
			};
			const byId = new Map(body.items.map((s) => [s.id, s.issueRef]));
			expect(byId.get(linkedSession.id)).toBe(`${projectKey}-${issue.number}`);
			expect(byId.get(unlinkedSession.id)).toBeNull();
		});

		it("projectId filters to sessions linked to an issue in that project (key or uuid); excludes unlinked sessions", async () => {
			const otherFixture = await seedProjectFixture(); // separate workspace/project entirely
			void otherFixture;

			const issue = await seedIssue(workspaceId, projectId, userId, { title: "In project" });
			const linked = await registerAgent({ name: "proj-linked-932", issueId: issue.id });
			const linkedSession = (await linked.json()) as { id: string };
			const unlinked = await registerAgent({ name: "proj-unlinked-932" });
			const unlinkedSession = (await unlinked.json()) as { id: string };

			const byKey = await listAgents({ projectId: projectKey });
			const byKeyBody = (await byKey.json()) as { items: Array<{ id: string }> };
			const byKeyIds = byKeyBody.items.map((s) => s.id);
			expect(byKeyIds).toContain(linkedSession.id);
			expect(byKeyIds).not.toContain(unlinkedSession.id);

			const byUuid = await listAgents({ projectId });
			const byUuidBody = (await byUuid.json()) as { items: Array<{ id: string }> };
			expect(byUuidBody.items.map((s) => s.id)).toContain(linkedSession.id);
		});
	});
});
