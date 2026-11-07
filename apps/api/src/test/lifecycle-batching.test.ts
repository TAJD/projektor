import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	endAgent,
	finishWork,
	heartbeatAgent,
	registerAgent,
	startWork,
} from "../services/agents";
import { postMessage } from "../services/agent-messages";
import {
	buildLeaseClaimStatements,
	claimIssue,
	readLeaseClaimState,
	settleLeaseClaim,
} from "../services/issue-leases";
import type { ServiceCtx } from "../services/types";
import {
	seedAgentLease,
	seedIssue,
	seedMember,
	seedProjectFixture,
	seedUser,
} from "./helpers";

function trackD1RoundTrips() {
	let count = 0;
	const origPrepare = env.DB.prepare.bind(env.DB);
	const origBatch = env.DB.batch.bind(env.DB);
	const EXEC_METHODS = new Set(["run", "all", "get", "first", "raw"]);

	const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "bind") {
					return (...args: unknown[]) =>
						wrapStmt((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
				}
				if (typeof prop === "string" && EXEC_METHODS.has(prop)) {
					return (...args: unknown[]) => {
						count++;
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return value.bind(target);
			},
		});

	vi.spyOn(env.DB, "prepare").mockImplementation(
		(q: string) => wrapStmt(origPrepare(q)) as D1PreparedStatement
	);
	vi.spyOn(env.DB, "batch").mockImplementation((stmts: D1PreparedStatement[]) => {
		count++;
		return origBatch(stmts);
	});

	return { count: () => count };
}

type Fixture = Awaited<ReturnType<typeof seedProjectFixture>>;

function ctxFor(f: Fixture, role: ServiceCtx["role"] = "owner", userId = f.userId): ServiceCtx {
	return { db: env.DB, kv: env.KV, r2: env.R2, workspaceId: f.workspaceId, userId, role };
}

const q = <T>(sql: string, ...binds: unknown[]) =>
	env.DB.prepare(sql)
		.bind(...binds)
		.all<T>()
		.then((r) => r.results);

describe("PROJ-1017: agent lifecycle round trips", () => {
	let f: Fixture;
	let ctx: ServiceCtx;

	beforeEach(async () => {
		f = await seedProjectFixture({ role: "owner" });
		ctx = ctxFor(f);
	});
	afterEach(() => vi.restoreAllMocks());

	async function newIssue(title = "Lifecycle") {
		return seedIssue(f.workspaceId, f.projectId, f.userId, { title });
	}

	it("start_work without paths is 2 round trips (was ~19)", async () => {
		const issue = await newIssue();
		const tracker = trackD1RoundTrips();
		const res = await startWork(ctx, { issue: issue.id, name: "w" });
		expect(tracker.count()).toBeLessThanOrEqual(2);
		expect(res.lease.issueId).toBe(issue.id);
		expect(res.lease.agentSessionId).toBe(res.sessionId);
		expect(res.claimedFiles).toEqual([]);

		const messages = await q<{ body: string }>(
			"SELECT body FROM agent_messages WHERE scope = ? AND workspace_id = ?",
			`issue:${issue.id}`,
			f.workspaceId
		);
		expect(messages.map((m) => m.body)).toEqual(["w started work"]);
	});

	it("start_work with paths is at most 5 round trips (was ~25)", async () => {
		const issue = await newIssue();
		const tracker = trackD1RoundTrips();
		const res = await startWork(ctx, {
			issue: issue.id,
			paths: ["src/a.ts", "src/b.ts", "src/a.ts"],
			name: "w",
		});
		expect(tracker.count()).toBeLessThanOrEqual(5);
		expect(res.claimedFiles.map((c) => c.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);

		const messages = await q<{ body: string }>(
			"SELECT body FROM agent_messages WHERE scope = ? AND workspace_id = ?",
			`issue:${issue.id}`,
			f.workspaceId
		);
		expect(messages.map((m) => m.body)).toEqual(["w started work"]);
	});

	it("start_work by ref resolves and claims", async () => {
		const issue = await newIssue();
		const [{ number }] = await q<{ number: number }>("SELECT number FROM issues WHERE id = ?", issue.id);
		const res = await startWork(ctx, { issue: `PROJ-${number}`, name: "w" });
		expect(res.lease.issueId).toBe(issue.id);
	});

	it("start_work on a missing issue registers nothing", async () => {
		await expect(
			startWork(ctx, { issue: crypto.randomUUID(), name: "ghost" })
		).rejects.toMatchObject({ kind: "not_found" });
		expect(await q("SELECT id FROM agent_sessions WHERE name = 'ghost'")).toEqual([]);
	});

	it("start_work reclaims a stale holder's lease in the same write", async () => {
		const issue = await newIssue();
		const stale = await seedAgentLease(f.workspaceId, issue.id, { live: true });
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(Math.floor(Date.now() / 1000) - 500, stale.agentSessionId)
			.run();
		const res = await startWork(ctx, { issue: issue.id, name: "w" });
		const rows = await q<{ released_at: number | null; release_reason: string | null }>(
			"SELECT released_at, release_reason FROM issue_leases WHERE id = ?",
			stale.leaseId
		);
		expect(rows[0].release_reason).toBe("expired");
		expect(res.lease.issueId).toBe(issue.id);
	});

	it("start_work against a live lease conflicts without registering a session", async () => {
		const issue = await newIssue();
		await seedAgentLease(f.workspaceId, issue.id, { live: true });
		await expect(startWork(ctx, { issue: issue.id, name: "late" })).rejects.toMatchObject({
			kind: "conflict",
		});
		expect(await q("SELECT id FROM agent_sessions WHERE name = 'late'")).toEqual([]);
	});

	it("start_work denied by the WIP cap ends its session and records the denial", async () => {
		await env.DB.prepare("UPDATE projects SET agent_wip_limit = 1 WHERE id = ?")
			.bind(f.projectId)
			.run();
		const first = await newIssue("one");
		const second = await newIssue("two");
		await startWork(ctx, { issue: first.id, name: "holder" });

		await expect(startWork(ctx, { issue: second.id, name: "denied" })).rejects.toMatchObject({
			kind: "conflict",
		});
		const sessions = await q<{ status: string }>(
			"SELECT status FROM agent_sessions WHERE name = 'denied'"
		);
		expect(sessions.map((s) => s.status)).toEqual(["ended"]);
		const denials = await q("SELECT id FROM wip_cap_denials WHERE issue_id = ?", second.id);
		expect(denials).toHaveLength(1);
		expect(await q("SELECT id FROM issue_leases WHERE issue_id = ?", second.id)).toEqual([]);
		expect(await q("SELECT id FROM agent_messages WHERE body = 'denied started work'")).toEqual([]);
	});

	it("claim_issue is one read batch plus one write batch", async () => {
		const issue = await newIssue();
		const session = await registerAgent(ctx, { name: "claimer" });
		const tracker = trackD1RoundTrips();
		const lease = await claimIssue(ctx, { issueId: issue.id, agentId: session.id });
		expect(tracker.count()).toBe(2);
		const [stored] = await q<{ id: string; claimed_at: number; agent_session_id: string }>(
			"SELECT id, claimed_at, agent_session_id FROM issue_leases WHERE id = ?",
			lease.id
		);
		expect(stored).toMatchObject({ agent_session_id: session.id, claimed_at: lease.claimedAt });
		expect(lease).toMatchObject({
			workspaceId: f.workspaceId,
			issueId: issue.id,
			agentSessionId: session.id,
			releasedAt: null,
			releaseReason: null,
		});
	});

	it("claim_issue by a live holder's rival still refreshes the rival's heartbeat", async () => {
		const issue = await newIssue();
		await seedAgentLease(f.workspaceId, issue.id, { live: true });
		const rival = await registerAgent(ctx, { name: "rival" });
		const old = Math.floor(Date.now() / 1000) - 60;
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(old, rival.id)
			.run();

		await expect(claimIssue(ctx, { issueId: issue.id, agentId: rival.id })).rejects.toMatchObject({
			kind: "conflict",
		});
		const [row] = await q<{ last_heartbeat_at: number }>(
			"SELECT last_heartbeat_at FROM agent_sessions WHERE id = ?",
			rival.id
		);
		expect(row.last_heartbeat_at).toBeGreaterThan(old);
	});

	it("a lost unique race is a conflict, and the heartbeat write in the batch survives it", async () => {
		const issue = await newIssue();
		const session = await registerAgent(ctx, { name: "loser" });
		const old = Math.floor(Date.now() / 1000) - 60;
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(old, session.id)
			.run();

		const cutoff = Math.floor(Date.now() / 1000) - 120;
		const state = await readLeaseClaimState(ctx, { issueId: issue.id, agentId: session.id, cutoff });
		await seedAgentLease(f.workspaceId, issue.id, { live: true });

		const plan = buildLeaseClaimStatements(ctx, {
			issueId: issue.id,
			agentId: session.id,
			state,
			cutoff,
			now: Math.floor(Date.now() / 1000),
			touchHeartbeat: true,
		});
		const results = await env.DB.batch(plan.statements);
		await expect(settleLeaseClaim(ctx, plan, results[plan.insertIndex])).rejects.toThrow(
			"Issue was just leased by another agent"
		);

		const [row] = await q<{ last_heartbeat_at: number }>(
			"SELECT last_heartbeat_at FROM agent_sessions WHERE id = ?",
			session.id
		);
		expect(row.last_heartbeat_at).toBeGreaterThan(old);
		expect(await q("SELECT id FROM wip_cap_denials WHERE issue_id = ?", issue.id)).toEqual([]);
	});

	it("a cap race lost after the read is a WIP-limit conflict and is recorded", async () => {
		await env.DB.prepare("UPDATE projects SET agent_wip_limit = 1 WHERE id = ?")
			.bind(f.projectId)
			.run();
		const a = await newIssue("a");
		const b = await newIssue("b");
		const session = await registerAgent(ctx, { name: "capped" });
		const cutoff = Math.floor(Date.now() / 1000) - 120;
		const state = await readLeaseClaimState(ctx, { issueId: b.id, agentId: session.id, cutoff });
		await seedAgentLease(f.workspaceId, a.id, { live: true });

		const plan = buildLeaseClaimStatements(ctx, {
			issueId: b.id,
			agentId: session.id,
			state,
			cutoff,
			now: Math.floor(Date.now() / 1000),
			touchHeartbeat: true,
		});
		const results = await env.DB.batch(plan.statements);
		await expect(settleLeaseClaim(ctx, plan, results[plan.insertIndex])).rejects.toThrow(
			/WIP limit reached \(1\); currently held: /
		);
		expect(await q("SELECT id FROM wip_cap_denials WHERE issue_id = ?", b.id)).toHaveLength(1);
	});

	it("end_agent is one batch and releases leases and claims", async () => {
		const issue = await newIssue();
		const started = await startWork(ctx, { issue: issue.id, paths: ["x.ts"], name: "w" });
		const tracker = trackD1RoundTrips();
		const ended = await endAgent(ctx, { id: started.sessionId });
		expect(tracker.count()).toBe(1);
		expect(ended).toMatchObject({ id: started.sessionId, status: "ended" });
		expect(ended.endedAt).toBeGreaterThan(0);
		expect(Object.keys(ended).sort()).toEqual(
			[
				"endedAt",
				"id",
				"issueId",
				"lastHeartbeatAt",
				"name",
				"startedAt",
				"status",
				"tokenId",
				"workspaceId",
			].sort()
		);
		const lease = await q<{ release_reason: string }>(
			"SELECT release_reason FROM issue_leases WHERE issue_id = ?",
			issue.id
		);
		expect(lease[0].release_reason).toBe("agent_ended");
		const claim = await q<{ release_reason: string }>(
			"SELECT release_reason FROM issue_file_claims WHERE issue_id = ?",
			issue.id
		);
		expect(claim[0].release_reason).toBe("agent_ended");
	});

	it("end_agent on an unknown session is not found and releases nothing", async () => {
		const issue = await newIssue();
		const held = await seedAgentLease(f.workspaceId, issue.id, { live: true });
		await expect(endAgent(ctx, { id: crypto.randomUUID() })).rejects.toMatchObject({
			kind: "not_found",
		});
		const [row] = await q<{ released_at: number | null }>(
			"SELECT released_at FROM issue_leases WHERE id = ?",
			held.leaseId
		);
		expect(row.released_at).toBeNull();
	});

	it("heartbeat is one round trip, refuses an ended session, and returns the new heartbeat", async () => {
		const session = await registerAgent(ctx, { name: "hb" });
		const old = Math.floor(Date.now() / 1000) - 60;
		await env.DB.prepare("UPDATE agent_sessions SET last_heartbeat_at = ? WHERE id = ?")
			.bind(old, session.id)
			.run();
		const tracker = trackD1RoundTrips();
		const row = await heartbeatAgent(ctx, { id: session.id });
		expect(tracker.count()).toBe(1);
		expect(row.lastHeartbeatAt).toBeGreaterThan(old);
		expect(row.status).toBe("active");

		await endAgent(ctx, { id: session.id });
		await expect(heartbeatAgent(ctx, { id: session.id })).rejects.toMatchObject({
			kind: "not_found",
		});
	});

	it("register_agent is one round trip with an issue-less session and two with an issue", async () => {
		const issue = await newIssue();
		let tracker = trackD1RoundTrips();
		const bare = await registerAgent(ctx, { name: "bare" });
		expect(tracker.count()).toBe(1);
		expect(bare).toMatchObject({ name: "bare", status: "active", issueId: null, endedAt: null });
		vi.restoreAllMocks();

		tracker = trackD1RoundTrips();
		const linked = await registerAgent(ctx, { name: "linked", issueId: issue.id });
		expect(tracker.count()).toBe(2);
		expect(linked.issueId).toBe(issue.id);
		await expect(
			registerAgent(ctx, { name: "orphan", issueId: crypto.randomUUID() })
		).rejects.toMatchObject({ kind: "not_found" });
	});

	it("post_message is one write batch after the scope resolves", async () => {
		const issue = await newIssue();
		const session = await registerAgent(ctx, { name: "poster" });
		const tracker = trackD1RoundTrips();
		const row = await postMessage(ctx, {
			scope: `issue:${issue.id}`,
			agentId: session.id,
			body: "hello",
		});
		expect(tracker.count()).toBe(2);
		expect(row).toMatchObject({
			scope: `issue:${issue.id}`,
			agentId: session.id,
			body: "hello",
			workspaceId: f.workspaceId,
		});
		const [stored] = await q<{ created_at: number }>(
			"SELECT created_at FROM agent_messages WHERE id = ?",
			row.id
		);
		expect(stored.created_at).toBe(row.createdAt);
	});

	it("post_message with an unknown agent is not found and stores nothing", async () => {
		await expect(
			postMessage(ctx, { scope: "workspace", agentId: crypto.randomUUID(), body: "ghost" })
		).rejects.toMatchObject({ kind: "not_found" });
		expect(await q("SELECT id FROM agent_messages WHERE body = 'ghost'")).toEqual([]);
	});

	it("post_message without an agent is one round trip on the workspace channel", async () => {
		const tracker = trackD1RoundTrips();
		await postMessage(ctx, { scope: "workspace", body: "notice" });
		expect(tracker.count()).toBe(1);
	});

	it("finish_work to done with a report is at most 6 round trips (updateIssue's own reads dominate)", async () => {
		const issue = await newIssue();
		const started = await startWork(ctx, { issue: issue.id, paths: ["f.ts"], name: "w" });
		const tracker = trackD1RoundTrips();
		await finishWork(ctx, {
			sessionId: started.sessionId,
			issue: issue.id,
			status: "done",
			completionReport: { summary: "ok", verification: "pnpm test" },
		});
		expect(tracker.count()).toBeLessThanOrEqual(6);
		const [session] = await q<{ status: string }>(
			"SELECT status FROM agent_sessions WHERE id = ?",
			started.sessionId
		);
		expect(session.status).toBe("ended");
	});

	it("finish_work into review with a report is at most 5 round trips", async () => {
		const issue = await newIssue();
		const started = await startWork(ctx, { issue: issue.id, name: "w" });
		const tracker = trackD1RoundTrips();
		await finishWork(ctx, {
			sessionId: started.sessionId,
			issue: issue.id,
			status: "in_review",
			completionReport: { summary: "ok", verification: "pnpm test" },
		});
		expect(tracker.count()).toBeLessThanOrEqual(5);
	});

	it("finish_work with no transition is two round trips and still 404s a missing issue", async () => {
		const issue = await newIssue();
		const started = await startWork(ctx, { issue: issue.id, name: "w" });
		const tracker = trackD1RoundTrips();
		await finishWork(ctx, { sessionId: started.sessionId, issue: issue.id });
		expect(tracker.count()).toBe(2);
		vi.restoreAllMocks();

		const other = await registerAgent(ctx, { name: "other" });
		await expect(
			finishWork(ctx, { sessionId: other.id, issue: crypto.randomUUID() })
		).rejects.toMatchObject({ kind: "not_found" });
	});

	describe("visibility", () => {
		let memberCtx: ServiceCtx;
		let hidden: { id: string };

		beforeEach(async () => {
			const member = await seedUser(`m-${crypto.randomUUID().slice(0, 8)}@example.com`);
			await seedMember(f.workspaceId, member.id, "member");
			memberCtx = ctxFor(f, "member", member.id);
			hidden = await newIssue("hidden");
		});

		it("claim_issue and start_work treat a project the caller cannot see as not found", async () => {
			const session = await registerAgent(ctx, { name: "owner-session" });
			await expect(
				claimIssue(memberCtx, { issueId: hidden.id, agentId: session.id })
			).rejects.toMatchObject({ kind: "not_found" });
			await expect(startWork(memberCtx, { issue: hidden.id, name: "x" })).rejects.toMatchObject({
				kind: "not_found",
			});
			expect(await q("SELECT id FROM issue_leases WHERE issue_id = ?", hidden.id)).toEqual([]);
		});

		it("end_agent and heartbeat cannot reach a session tied to a hidden issue", async () => {
			const started = await startWork(ctx, { issue: hidden.id, name: "owner-work" });
			await expect(endAgent(memberCtx, { id: started.sessionId })).rejects.toMatchObject({
				kind: "not_found",
			});
			await expect(heartbeatAgent(memberCtx, { id: started.sessionId })).rejects.toMatchObject({
				kind: "not_found",
			});
			const [lease] = await q<{ released_at: number | null }>(
				"SELECT released_at FROM issue_leases WHERE id = ?",
				started.lease.id
			);
			expect(lease.released_at).toBeNull();
			const [session] = await q<{ status: string }>(
				"SELECT status FROM agent_sessions WHERE id = ?",
				started.sessionId
			);
			expect(session.status).toBe("active");
		});
	});
});
