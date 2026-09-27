// PROJ-864: claim_files/release_files batch their per-path writes into a constant number
// of db.batch() calls instead of issuing 1-2+ D1 round trips per path (100 paths measured
// at 209 queries before this fix). This test proves it two ways: a direct round-trip count
// (proxying env.DB so a statement executed on its own counts once, and a whole db.batch()
// call — however many statements it carries — also counts once, matching how D1 actually
// bills a batch as a single request) and a behavioural check that conflict/force/stale
// semantics are unchanged at 100-path scale.

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, seedIssue, seedIssueFixture } from "./helpers";

/**
 * Counts D1 round trips: each statement executed on its own (via .run()/.all()/.get()/.raw(),
 * however drizzle or hand-written code invokes it) counts once, and each env.DB.batch() call
 * counts once regardless of how many statements it carries — mirroring the fact that D1's
 * batch API sends every statement in the array over the wire in a single request.
 */
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

	return {
		count: () => count,
		restore: () => vi.restoreAllMocks(),
	};
}

describe("PROJ-864: claim_files/release_files write batching", () => {
	afterEach(() => vi.restoreAllMocks());

	async function seedStaleClaim(workspaceId: string, issueId: string, path: string) {
		const agentId = crypto.randomUUID();
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`INSERT INTO agent_sessions
				(id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
			 VALUES (?, ?, NULL, NULL, 'stale-holder', 'agent', 'active', ?, ?, NULL)`
		)
			.bind(agentId, workspaceId, now, now - 200) // 200s > 120s TTL — stale, but status stays 'active'
			.run();
		await env.DB.prepare(
			`INSERT INTO issue_file_claims
				(id, workspace_id, issue_id, agent_id, path, claimed_at, released_at, release_reason)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
		)
			.bind(crypto.randomUUID(), workspaceId, issueId, agentId, path, now)
			.run();
	}

	async function seedLiveClaim(workspaceId: string, issueId: string, path: string) {
		const now = Math.floor(Date.now() / 1000);
		// agentId NULL — an agentless claim is always "live" (never auto-reclaimed).
		await env.DB.prepare(
			`INSERT INTO issue_file_claims
				(id, workspace_id, issue_id, agent_id, path, claimed_at, released_at, release_reason)
			 VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL)`
		)
			.bind(crypto.randomUUID(), workspaceId, issueId, path, now)
			.run();
	}

	it("claiming 100 paths (10 conflicts + 5 stale, force:true) uses ≤10 D1 round trips", async () => {
		const { token, slug, workspaceId, projectId, userId, issueId } = await seedIssueFixture();
		const holder = await seedIssue(workspaceId, projectId, userId, { title: "Holder" });

		const conflictPaths = Array.from({ length: 10 }, (_, i) => `src/conflict-${i}.ts`);
		const stalePaths = Array.from({ length: 5 }, (_, i) => `src/stale-${i}.ts`);
		const freshPaths = Array.from({ length: 85 }, (_, i) => `src/fresh-${i}.ts`);
		const paths = [...conflictPaths, ...stalePaths, ...freshPaths];
		expect(paths).toHaveLength(100);

		for (const p of conflictPaths) await seedLiveClaim(workspaceId, holder.id, p);
		for (const p of stalePaths) await seedStaleClaim(workspaceId, holder.id, p);

		const tracker = trackD1RoundTrips();
		const res = await SELF.fetch("http://localhost/api/file-claims", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths, force: true }),
		});
		const roundTrips = tracker.count();
		tracker.restore();

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			created: Array<{ path: string }>;
			overridden: Array<{ path: string }>;
			reclaimed: Array<{ path: string }>;
		};
		expect(body.created).toHaveLength(100);
		expect(body.overridden).toHaveLength(10);
		expect(body.reclaimed).toHaveLength(5);
		expect(roundTrips).toBeLessThanOrEqual(10);
	});

	it("rejecting a conflicting 100-path claim (force:false) still uses ≤10 D1 round trips", async () => {
		const { token, slug, workspaceId, projectId, userId, issueId } = await seedIssueFixture();
		const holder = await seedIssue(workspaceId, projectId, userId, { title: "Holder" });

		const conflictPaths = Array.from({ length: 10 }, (_, i) => `src/rconflict-${i}.ts`);
		const stalePaths = Array.from({ length: 5 }, (_, i) => `src/rstale-${i}.ts`);
		const freshPaths = Array.from({ length: 85 }, (_, i) => `src/rfresh-${i}.ts`);
		const paths = [...conflictPaths, ...stalePaths, ...freshPaths];

		for (const p of conflictPaths) await seedLiveClaim(workspaceId, holder.id, p);
		for (const p of stalePaths) await seedStaleClaim(workspaceId, holder.id, p);

		const tracker = trackD1RoundTrips();
		const res = await SELF.fetch("http://localhost/api/file-claims", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths }),
		});
		const roundTrips = tracker.count();
		tracker.restore();

		expect(res.status).toBe(409);
		expect(roundTrips).toBeLessThanOrEqual(10);

		// All-or-nothing: none of the fresh paths were claimed.
		const fresh = await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_file_claims WHERE path = ?")
			.bind("src/rfresh-0.ts")
			.first<{ n: number }>();
		expect(fresh?.n).toBe(0);

		// The stale claim was still reclaimed even though the overall request was rejected —
		// documented pre-existing behaviour (reclaim happens before conflict evaluation).
		const staleRow = await env.DB.prepare(
			"SELECT release_reason FROM issue_file_claims WHERE path = ?"
		)
			.bind("src/rstale-0.ts")
			.first<{ release_reason: string | null }>();
		expect(staleRow?.release_reason).toBe("expired");

		// Every contended path recorded a conflict row.
		const conflicts = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM claim_conflicts WHERE rejected_issue_id = ? AND forced = 0"
		)
			.bind(issueId)
			.first<{ n: number }>();
		expect(conflicts?.n).toBe(10);
	});

	// Measured end-to-end (through auth/rate-limit middleware, not just the service call):
	// 10 round trips before this fix's no-re-SELECT change, 6 after — ≤8 is what actually
	// discriminates it while staying under the ticket's ≤10.
	it("releasing 100 claimed paths uses ≤8 D1 round trips", async () => {
		const { token, slug, issueId } = await seedIssueFixture();
		const paths = Array.from({ length: 100 }, (_, i) => `src/release-${i}.ts`);

		const claimRes = await SELF.fetch("http://localhost/api/file-claims", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths }),
		});
		expect(claimRes.status).toBe(201);

		const tracker = trackD1RoundTrips();
		const res = await SELF.fetch("http://localhost/api/file-claims/release", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths }),
		});
		const roundTrips = tracker.count();
		tracker.restore();

		expect(res.status).toBe(200);
		const body = (await res.json()) as { released: Array<{ path: string }>; count: number };
		expect(body.count).toBe(100);
		expect(roundTrips).toBeLessThanOrEqual(8);
	});

	it("release reports only claims it actually released (a concurrent release is left alone)", async () => {
		const { token, slug, issueId } = await seedIssueFixture();
		const paths = Array.from({ length: 5 }, (_, i) => `src/race-${i}.ts`);
		const claimRes = await SELF.fetch("http://localhost/api/file-claims", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths }),
		});
		expect(claimRes.status).toBe(201);

		// Simulate another request releasing one claim between releaseFiles' read and its
		// write batch. Armed when the release UPDATE is prepared (i.e. after the read), so
		// the auth middleware's own batch() calls earlier in the request don't trigger it.
		const origPrepare = env.DB.prepare.bind(env.DB);
		const origBatch = env.DB.batch.bind(env.DB);
		let armed = false;
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			if (/^update "issue_file_claims"/i.test(q)) armed = true;
			return origPrepare(q);
		});
		vi.spyOn(env.DB, "batch").mockImplementation(async (stmts: D1PreparedStatement[]) => {
			if (armed) {
				armed = false;
				await origPrepare(
					"UPDATE issue_file_claims SET released_at = 1, release_reason = 'expired' WHERE path = ?"
				)
					.bind("src/race-0.ts")
					.run();
			}
			return origBatch(stmts);
		});
		const res = await SELF.fetch("http://localhost/api/file-claims/release", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths }),
		});
		vi.restoreAllMocks();

		expect(res.status).toBe(200);
		const body = (await res.json()) as { released: Array<{ path: string }>; count: number };
		expect(body.count).toBe(4);
		expect(body.released.map((r) => r.path)).not.toContain("src/race-0.ts");
		const raced = await env.DB.prepare(
			"SELECT released_at, release_reason FROM issue_file_claims WHERE path = ?"
		)
			.bind("src/race-0.ts")
			.first();
		expect(raced).toEqual({ released_at: 1, release_reason: "expired" });
	});

	it("claiming the same path twice in one request claims it once", async () => {
		const { token, slug, issueId } = await seedIssueFixture();
		const res = await SELF.fetch("http://localhost/api/file-claims", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths: ["src/b.ts", "src/a.ts", "src/b.ts"] }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { created: Array<{ path: string }> };
		expect(body.created.map((c) => c.path)).toEqual(["src/b.ts", "src/a.ts"]);
	});

	it("force-claim notifications stay within the 5,000-char message cap", async () => {
		const { token, slug, workspaceId, projectId, userId, issueId } = await seedIssueFixture();
		const holder = await seedIssue(workspaceId, projectId, userId, { title: "Holder" });
		// 100 paths of ~300 chars: the untruncated path list alone would be ~30,000 chars.
		const paths = Array.from(
			{ length: 100 },
			(_, i) => `src/${"deep/".repeat(58)}file-${String(i).padStart(3, "0")}.ts`
		);
		for (const p of paths) await seedLiveClaim(workspaceId, holder.id, p);

		const res = await SELF.fetch("http://localhost/api/file-claims", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ issueId, paths, force: true }),
		});
		expect(res.status).toBe(201);

		const messages = await env.DB.prepare(
			"SELECT scope, body FROM agent_messages WHERE scope IN (?, ?) ORDER BY scope"
		)
			.bind(`issue:${issueId}`, `issue:${holder.id}`)
			.all<{ scope: string; body: string }>();
		expect(messages.results).toHaveLength(2);
		for (const m of messages.results) {
			expect(m.body.length).toBeLessThanOrEqual(5000);
			expect(m.body).toContain(`"${paths[0]}"`);
			expect(m.body).toMatch(/…and \d+ more/);
		}
	});
});
