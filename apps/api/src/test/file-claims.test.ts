import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedIssue, seedIssueFixture } from "./helpers";

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

	// PROJ-337: rejecting a conflicting claim inserts a claim_conflicts row (forced=0)
	// 1 request (claim) + setup claim already counted below — within limit
	it("PROJ-337: rejecting a conflicting claim inserts a claim_conflicts row with forced=0", async () => {
		await claimFiles({ issueId, paths: ["src/conflict-log.ts"] });

		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Rejected issue" });
		const res = await claimFiles({ issueId: issue2.id, paths: ["src/conflict-log.ts"] });
		expect(res.status).toBe(409);

		const rows = await env.DB.prepare(
			"SELECT * FROM claim_conflicts WHERE workspace_id = ? AND path = ?"
		)
			.bind(workspaceId, "src/conflict-log.ts")
			.all();
		expect(rows.results).toHaveLength(1);
		const row = rows.results[0] as Record<string, unknown>;
		expect(row.forced).toBe(0);
		expect(row.rejected_issue_id).toBe(issue2.id);
		expect(row.holding_issue_id).toBe(issueId);
	});

	// PROJ-337: rejecting a call where multiple paths are held records one row per contended path
	it("PROJ-337: rejecting a multi-path claim records one row per contended path", async () => {
		await claimFiles({ issueId, paths: ["src/multi-a.ts", "src/multi-b.ts"] });

		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Multi rejected" });
		const res = await claimFiles({
			issueId: issue2.id,
			paths: ["src/multi-a.ts", "src/multi-b.ts"],
		});
		expect(res.status).toBe(409);

		const rows = await env.DB.prepare(
			"SELECT path FROM claim_conflicts WHERE workspace_id = ? AND rejected_issue_id = ? AND forced = 0"
		)
			.bind(workspaceId, issue2.id)
			.all();
		expect(rows.results).toHaveLength(2);
		const paths = rows.results.map((r) => (r as Record<string, unknown>).path).sort();
		expect(paths).toEqual(["src/multi-a.ts", "src/multi-b.ts"]);
	});

	// PROJ-337: force:true override inserts a claim_conflicts row (forced=1)
	it("PROJ-337: force:true override inserts a claim_conflicts row with forced=1", async () => {
		await claimFiles({ issueId, paths: ["src/force-log.ts"] });

		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Forcing issue" });
		const res = await claimFiles({
			issueId: issue2.id,
			paths: ["src/force-log.ts"],
			force: true,
		});
		expect(res.status).toBe(201);

		const rows = await env.DB.prepare(
			"SELECT * FROM claim_conflicts WHERE workspace_id = ? AND path = ?"
		)
			.bind(workspaceId, "src/force-log.ts")
			.all();
		expect(rows.results).toHaveLength(1);
		const row = rows.results[0] as Record<string, unknown>;
		expect(row.forced).toBe(1);
		expect(row.rejected_issue_id).toBe(issue2.id);
		expect(row.holding_issue_id).toBe(issueId);
	});

	// PROJ-337: a non-conflicting claim inserts no claim_conflicts rows
	it("PROJ-337: a non-conflicting claim inserts no claim_conflicts rows", async () => {
		const res = await claimFiles({ issueId, paths: ["src/no-conflict.ts"] });
		expect(res.status).toBe(201);

		const rows = await env.DB.prepare(
			"SELECT * FROM claim_conflicts WHERE workspace_id = ? AND path = ?"
		)
			.bind(workspaceId, "src/no-conflict.ts")
			.all();
		expect(rows.results).toHaveLength(0);
	});

	async function listMessagesForScope(scope: string) {
		const res = await SELF.fetch(
			`http://localhost/api/agent-messages?scope=${encodeURIComponent(scope)}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		return (await res.json()) as { items: Array<{ body: string }> };
	}

	// PROJ-624: rejection (force=false) must not post any agent message — this was
	// previously mis-stated in the project's own docs as a message-posting path.
	it("PROJ-624: a rejected claim (force=false) posts no agent message to any scope", async () => {
		await claimFiles({ issueId, paths: ["src/no-message-on-reject.ts"] });

		const issue2 = await seedIssue(workspaceId, projectId, userId, {
			title: "Rejected, no message",
		});
		const res = await claimFiles({ issueId: issue2.id, paths: ["src/no-message-on-reject.ts"] });
		expect(res.status).toBe(409);

		const holderMessages = await listMessagesForScope(`issue:${issueId}`);
		expect(holderMessages.items).toHaveLength(0);

		const rejectedMessages = await listMessagesForScope(`issue:${issue2.id}`);
		expect(rejectedMessages.items).toHaveLength(0);
	});

	// PROJ-624: force:true DOES post a message, scoped to the issue that ends up
	// holding the claim after the override (not the prior holder that lost it).
	it("PROJ-624: force:true override posts a message scoped to the now-holding issue", async () => {
		await claimFiles({ issueId, paths: ["src/message-on-force.ts"] });

		const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Force claims" });
		const forceRes = await claimFiles({
			issueId: issue2.id,
			paths: ["src/message-on-force.ts"],
			force: true,
		});
		expect(forceRes.status).toBe(201);

		const messages = await listMessagesForScope(`issue:${issue2.id}`);
		expect(messages.items).toHaveLength(1);
		expect(messages.items[0].body).toContain("src/message-on-force.ts");
		expect(messages.items[0].body).toContain(issueId);

		const priorHolderMessages = await listMessagesForScope(`issue:${issueId}`);
		expect(priorHolderMessages.items).toHaveLength(0);
	});

	// PROJ-636: a claim whose holding session stopped heartbeating is reclaimed by the next
	// claim on that path, the way issue leases already were.
	//
	// The distinction that matters throughout: a *crashed* agent keeps status 'active' with a
	// stale heartbeat, because status only becomes 'ended' when it calls end_agent — which by
	// definition it didn't. B4b above covers the clean-exit path; none of these do.
	describe("PROJ-636: stale-holder reclaim", () => {
		async function seedSession(
			opts: Readonly<{ status?: string; heartbeatAgeSecs?: number; name?: string }> = {}
		): Promise<string> {
			const id = crypto.randomUUID();
			const now = Math.floor(Date.now() / 1000);
			await env.DB.prepare(
				`INSERT INTO agent_sessions
	         (id, workspace_id, issue_id, token_id, name, kind, status, started_at,
	          last_heartbeat_at, ended_at)
	       VALUES (?, ?, NULL, NULL, ?, 'agent', ?, ?, ?, NULL)`
			)
				.bind(
					id,
					workspaceId,
					opts.name ?? "crashed-agent",
					opts.status ?? "active",
					now,
					now - (opts.heartbeatAgeSecs ?? 0)
				)
				.run();
			return id;
		}

		async function claimRow(path: string) {
			return env.DB.prepare(
				"SELECT released_at, release_reason FROM issue_file_claims WHERE path = ? AND workspace_id = ?"
			)
				.bind(path, workspaceId)
				.first<{ released_at: number | null; release_reason: string | null }>();
		}

		it("a crashed agent's claim no longer blocks another issue", async () => {
			// 200s > the 120s TTL. Status stays 'active' — that is the whole point.
			const dead = await seedSession({ heartbeatAgeSecs: 200 });
			expect(
				(await claimFiles({ issueId, agentId: dead, paths: ["src/abandoned.ts"] })).status
			).toBe(201);

			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Takes over" });
			const res = await claimFiles({ issueId: issue2.id, paths: ["src/abandoned.ts"] });
			expect(res.status).toBe(201);

			const body = (await res.json()) as {
				created: Array<{ issueId: string }>;
				reclaimed: Array<{ path: string; releaseReason: string }>;
			};
			expect(body.created[0].issueId).toBe(issue2.id);
			// Reported, not silent: an agent that took over an abandoned path should be able to
			// tell that from an uncontested first claim.
			expect(body.reclaimed.map((r) => r.path)).toEqual(["src/abandoned.ts"]);
			expect(body.reclaimed[0].releaseReason).toBe("expired");
		});

		it("marks the reclaimed claim expired, distinct from agent_ended", async () => {
			const dead = await seedSession({ heartbeatAgeSecs: 200 });
			await claimFiles({ issueId, agentId: dead, paths: ["src/reason.ts"] });

			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Takes over" });
			await claimFiles({ issueId: issue2.id, paths: ["src/reason.ts"] });

			// Two rows now share this path; the released one is the original holder's.
			const released = await env.DB.prepare(
				"SELECT release_reason FROM issue_file_claims WHERE path = ? AND released_at IS NOT NULL"
			)
				.bind("src/reason.ts")
				.first<{ release_reason: string }>();
			// Not 'agent_ended' — the factory-health tile uses that to mean a clean exit, and a
			// crash reported as a clean exit would hide exactly the failure this ticket is about.
			expect(released?.release_reason).toBe("expired");
		});

		it("a live agent's claim still blocks, and is not silently expired", async () => {
			// The control. Without this, a bug that expired every claim regardless of heartbeat
			// would satisfy every other test in this block.
			const live = await seedSession({ heartbeatAgeSecs: 5, name: "live-agent" });
			await claimFiles({ issueId, agentId: live, paths: ["src/held.ts"] });

			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Blocked" });
			expect((await claimFiles({ issueId: issue2.id, paths: ["src/held.ts"] })).status).toBe(409);
			expect((await claimRow("src/held.ts"))?.released_at).toBeNull();
		});

		it("an agentless claim is never auto-reclaimed", async () => {
			// No session means no heartbeat to judge, so these stay held and `force` remains the
			// only way past them. Guards the deliberate choice not to fall back on claim age.
			await claimFiles({ issueId, paths: ["src/no-agent.ts"] });

			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Blocked" });
			expect((await claimFiles({ issueId: issue2.id, paths: ["src/no-agent.ts"] })).status).toBe(
				409
			);
		});

		it("does not record a conflict when superseding a dead holder", async () => {
			const dead = await seedSession({ heartbeatAgeSecs: 200 });
			await claimFiles({ issueId, agentId: dead, paths: ["src/no-conflict.ts"] });

			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Takes over" });
			await claimFiles({ issueId: issue2.id, paths: ["src/no-conflict.ts"] });

			// claim_conflicts drives the heatmap's contention mode, whose argument is that a
			// repeatedly-hot path says something about how the work was sliced. Fleet mortality
			// is not contention, so counting it there would corrupt the signal.
			const conflicts = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM claim_conflicts WHERE path = ?"
			)
				.bind("src/no-conflict.ts")
				.first<{ n: number }>();
			expect(conflicts?.n).toBe(0);
		});

		it("still records a conflict when the holder is live", async () => {
			// The paired control for the assertion above: proves the zero there comes from the
			// holder being dead, not from conflict recording having been broken outright.
			const live = await seedSession({ heartbeatAgeSecs: 5 });
			await claimFiles({ issueId, agentId: live, paths: ["src/live-conflict.ts"] });

			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Rejected" });
			await claimFiles({ issueId: issue2.id, paths: ["src/live-conflict.ts"] });

			const conflicts = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM claim_conflicts WHERE path = ?"
			)
				.bind("src/live-conflict.ts")
				.first<{ n: number }>();
			expect(conflicts?.n).toBe(1);
		});

		it("reclaims only the stale paths in a mixed multi-path claim", async () => {
			// Claims are all-or-nothing, so a request spanning a dead holder and a live one must
			// still be refused whole — and must not expire the dead one as a side effect of a
			// request that failed.
			const dead = await seedSession({ heartbeatAgeSecs: 200 });
			const live = await seedSession({ heartbeatAgeSecs: 5 });
			await claimFiles({ issueId, agentId: dead, paths: ["src/dead-path.ts"] });
			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Live holder" });
			await claimFiles({ issueId: issue2.id, agentId: live, paths: ["src/live-path.ts"] });

			const issue3 = await seedIssue(workspaceId, projectId, userId, { title: "Wants both" });
			const res = await claimFiles({
				issueId: issue3.id,
				paths: ["src/dead-path.ts", "src/live-path.ts"],
			});
			expect(res.status).toBe(409);

			// The live path is untouched.
			expect((await claimRow("src/live-path.ts"))?.released_at).toBeNull();
			// The dead one was released on the way through. Documenting the actual behaviour
			// rather than asserting the tidier alternative: reclaim happens before conflict
			// evaluation, so a refused request can still have freed an abandoned path. That is
			// harmless — the path was reclaimable by anyone — but it is a real ordering
			// consequence and worth pinning so a future change to it is a visible decision.
			expect((await claimRow("src/dead-path.ts"))?.release_reason).toBe("expired");
		});

		it("list_file_claims flags a stale holder as not live", async () => {
			const dead = await seedSession({ heartbeatAgeSecs: 200 });
			await claimFiles({ issueId, agentId: dead, paths: ["src/listed-dead.ts"] });
			const live = await seedSession({ heartbeatAgeSecs: 5 });
			const issue2 = await seedIssue(workspaceId, projectId, userId, { title: "Live" });
			await claimFiles({ issueId: issue2.id, agentId: live, paths: ["src/listed-live.ts"] });

			const listRes = await listFileClaims();
			const body = (await listRes.json()) as { items: Array<{ path: string; live: boolean }> };
			const byPath = new Map(body.items.map((i) => [i.path, i.live]));
			expect(byPath.get("src/listed-dead.ts")).toBe(false);
			expect(byPath.get("src/listed-live.ts")).toBe(true);
		});
	});
});
