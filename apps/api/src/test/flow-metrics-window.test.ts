// PROJ-866: bound the flow-metrics window and stop loading every project issue.
//
// - Schema validation rejects an excessive since/until span with a 400 before any
//   query runs.
// - A snapshot-style equality test on a representative fixture, captured against the
//   pre-refactor implementation (apps/api/src/services/flow-metrics.ts as it stood
//   before this ticket), pins the exact output shape so the bucket-algorithm rewrite
//   in this ticket can't silently change a number.
// - A 2,000-issue project queried over a 12-week window stays within a small, fixed
//   number of D1 queries — proving the issue SELECT and lease lookup are now scoped to
//   the window instead of the whole project.

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFlowMetrics } from "../services/flow-metrics";
import type { ServiceCtx } from "../services/types";
import { authHeaders, seedProjectFixture } from "./helpers";

describe("PROJ-866: flow-metrics window validation", () => {
	let token: string;
	let slug: string;
	let projectId: string;

	beforeEach(async () => {
		({ token, slug, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	async function getFlowMetrics(qs: string) {
		return SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics?${qs}`, {
			headers: authHeaders(token, slug),
		});
	}

	it("400s a day-granularity window spanning more than 366 days", async () => {
		const now = Math.floor(Date.now() / 1000);
		const since = now - 400 * 86400;
		const res = await getFlowMetrics(`since=${since}&until=${now}&granularity=day`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: unknown };
		expect(JSON.stringify(body)).toMatch(/366 days/);
	});

	it("accepts a day-granularity window of exactly 366 days", async () => {
		const now = Math.floor(Date.now() / 1000);
		const since = now - 366 * 86400;
		const res = await getFlowMetrics(`since=${since}&until=${now}&granularity=day`);
		expect(res.status).toBe(200);
	});

	it("400s a week-granularity window spanning more than 5 years", async () => {
		const now = Math.floor(Date.now() / 1000);
		const since = now - (5 * 365 * 86400 + 86400);
		const res = await getFlowMetrics(`since=${since}&until=${now}&granularity=week`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: unknown };
		expect(JSON.stringify(body)).toMatch(/5 years/);
	});

	it("accepts a week-granularity window of exactly 5 years", async () => {
		const now = Math.floor(Date.now() / 1000);
		const since = now - 5 * 365 * 86400;
		const res = await getFlowMetrics(`since=${since}&until=${now}&granularity=week`);
		expect(res.status).toBe(200);
	});

	it("400s `since=0` with day granularity (the reported case) instead of computing tens of thousands of buckets", async () => {
		const res = await getFlowMetrics("since=0&granularity=day");
		expect(res.status).toBe(400);
	});

	it("400s until < since", async () => {
		const now = Math.floor(Date.now() / 1000);
		const res = await getFlowMetrics(`since=${now}&until=${now - 1000}`);
		expect(res.status).toBe(400);
	});

	it("does not require since/until at all — the fully-default call is unaffected", async () => {
		const res = await getFlowMetrics("");
		expect(res.status).toBe(200);
	});

	it("400s when only `since` is given and it is more than 366 days before now at day granularity", async () => {
		const now = Math.floor(Date.now() / 1000);
		const since = now - 400 * 86400;
		const res = await getFlowMetrics(`since=${since}&granularity=day`);
		expect(res.status).toBe(400);
	});
});

describe("PROJ-866: bucket-rewrite fidelity (snapshot on a representative fixture)", () => {
	// A fixture exercising every bucketed series (WIP, throughput, bug share, review
	// latency, CFD, arrival/completion) with issues at different lifecycle stages,
	// spanning a 3-week window at day granularity so bucket boundaries and edge-clamping
	// are both exercised. Captured against the pre-rewrite implementation; any future
	// change to the bucket algorithms must keep producing this exact shape.
	it("produces the pinned output for a representative multi-stage fixture", async () => {
		const { token, slug, workspaceId, projectId, userId } = await seedProjectFixture({
			role: "owner",
		});
		const DAY = 86400;
		const WEEK = 7 * DAY;
		// A fixed past window, not one relative to "now": the output carries date labels
		// (bucketStart/date), so a now-relative fixture changed the snapshot every day.
		// The window is entirely in the past, so the service's clamping to "now" (the CFD
		// sample time) never applies, and every issue is in backlog, so agingWip is empty.
		const windowEnd = Date.UTC(2026, 5, 1) / 1000; // 2026-06-01T00:00:00Z, a Monday
		// An hour into a day, not day-aligned: wipOverTime's first sample is at that day's
		// start, before `since`, so the fixture covers the SQL lower bound being pushed
		// back to it (PROJ-866 review).
		const since = windowEnd - 3 * WEEK + 3600;
		const until = windowEnd;

		async function seedIssueWithStamps(
			title: string,
			stamps: Readonly<{
				createdAt: number;
				readyAt?: number;
				claimedAt?: number;
				inReviewAt?: number;
				doneAt?: number;
				typeKey?: string;
			}>
		): Promise<string> {
			const id = crypto.randomUUID();
			await env.DB.prepare(
				`INSERT INTO issues (id, workspace_id, project_id, number, title, body, status, priority,
					labels, created_by_id, created_at, updated_at, ready_at, claimed_at, in_review_at, done_at)
				SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, '', 'backlog', 'none', '[]', ?, ?, ?, ?, ?, ?, ?
				FROM issues WHERE project_id = ?`
			)
				.bind(
					id,
					workspaceId,
					projectId,
					title,
					userId,
					stamps.createdAt,
					stamps.createdAt,
					stamps.readyAt ?? null,
					stamps.claimedAt ?? null,
					stamps.inReviewAt ?? null,
					stamps.doneAt ?? null,
					projectId
				)
				.run();
			if (stamps.typeKey) {
				const typeId = crypto.randomUUID();
				await env.DB.prepare(
					`INSERT INTO task_types (id, workspace_id, key, name, position) VALUES (?, ?, ?, ?, 0)`
				)
					.bind(typeId, workspaceId, stamps.typeKey, stamps.typeKey)
					.run();
				await env.DB.prepare("UPDATE issues SET type_id = ? WHERE id = ?").bind(typeId, id).run();
			}
			return id;
		}

		// Still in backlog for the whole window.
		await seedIssueWithStamps("Backlog", { createdAt: since - DAY });
		// In progress by the end of the window.
		await seedIssueWithStamps("In progress", { createdAt: since - DAY, claimedAt: since + WEEK });
		// A bug completed inside the window, having gone through review.
		await seedIssueWithStamps("Bug done", {
			createdAt: since - DAY,
			readyAt: since - DAY,
			claimedAt: since + 10,
			inReviewAt: since + WEEK,
			doneAt: since + WEEK + 100,
			typeKey: "bug",
		});
		// A non-bug completed just before the window's end.
		await seedIssueWithStamps("Feature done", {
			createdAt: since + 5,
			readyAt: since + 5,
			claimedAt: since + 20,
			doneAt: until - 10,
			typeKey: "feature",
		});
		// Created inside the window, not yet done — an arrival with no completion.
		await seedIssueWithStamps("New arrival", { createdAt: until - 100 });
		// Done well before the window: in the CFD done band at every sample.
		await seedIssueWithStamps("Done long ago", {
			createdAt: since - 4 * WEEK,
			claimedAt: since - 3 * WEEK,
			doneAt: since - 2 * WEEK,
		});
		// Done after the first WIP sample (the day start) but before `since`: WIP there.
		await seedIssueWithStamps("Done just before since", {
			createdAt: since - WEEK,
			claimedAt: since - DAY,
			doneAt: since - 60,
		});

		const res = await SELF.fetch(
			`http://localhost/api/projects/${projectId}/flow-metrics?since=${since}&until=${until}&granularity=day`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const metrics = await res.json();

		expect(metrics).toMatchSnapshot();
	});
});

describe("PROJ-866: D1 query bound at scale", () => {
	it("2,000 in-window issues (plus 1,000 long-closed): <=10 D1 queries, same numbers", async () => {
		const { workspaceId, projectId, userId } = await seedProjectFixture({ role: "owner" });
		const WEEK = 7 * 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 12 * WEEK;
		const until = now;

		// Bulk-insert directly (one env.DB.batch, outside the counted section). All 2,000
		// in-window issues are done inside the window, so every one of them is in the set
		// the per-issue comment/lease lookups serve — the case that used to bind 2,000-id
		// IN-lists in 90-id chunks (23 statements per lookup). The 1,000 long-closed issues
		// finished before `since` and must stay out of the SQL result entirely.
		const IN_WINDOW = 2000;
		const agentSessionId = crypto.randomUUID();
		const statements: D1PreparedStatement[] = [
			env.DB.prepare(
				`INSERT INTO agent_sessions (id, workspace_id, issue_id, token_id, name, kind, status,
					started_at, last_heartbeat_at, ended_at)
				VALUES (?, ?, NULL, NULL, 'bulk', 'agent', 'ended', ?, ?, ?)`
			).bind(agentSessionId, workspaceId, since, since, since),
		];
		const insertIssue = (number: number, createdAt: number, claimedAt: number, doneAt: number) => {
			const id = crypto.randomUUID();
			statements.push(
				env.DB.prepare(
					`INSERT INTO issues (id, workspace_id, project_id, number, title, body, status, priority,
						labels, created_by_id, created_at, updated_at, claimed_at, done_at)
					VALUES (?, ?, ?, ?, ?, '', 'done', 'none', '[]', ?, ?, ?, ?, ?)`
				).bind(
					id,
					workspaceId,
					projectId,
					number,
					`Bulk ${number}`,
					userId,
					createdAt,
					createdAt,
					claimedAt,
					doneAt
				)
			);
			return id;
		};
		const longAgo = since - 20 * WEEK;
		for (let i = 0; i < 1000; i++) insertIssue(i + 1, longAgo, longAgo + 100, longAgo + 200);
		for (let i = 0; i < IN_WINDOW; i++) {
			const claimedAt = since + 60 * i;
			const id = insertIssue(1001 + i, since - 86400, claimedAt, claimedAt + 1000);
			// A human comment on every 10th issue, and a lease covering half the cycle time
			// on every 4th — so the joined lookups are exercised, not just counted.
			if (i % 10 === 0) {
				statements.push(
					env.DB.prepare(
						`INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at, author_kind)
						VALUES (?, ?, ?, 'c', ?, ?, 'human')`
					).bind(crypto.randomUUID(), id, userId, claimedAt, claimedAt)
				);
			}
			if (i % 4 === 0) {
				statements.push(
					env.DB.prepare(
						`INSERT INTO issue_leases (id, workspace_id, issue_id, agent_session_id, claimed_at, released_at, release_reason)
						VALUES (?, ?, ?, ?, ?, ?, 'released')`
					).bind(crypto.randomUUID(), workspaceId, id, agentSessionId, claimedAt, claimedAt + 500)
				);
			}
		}
		await env.DB.batch(statements);

		const ctx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId,
			userId,
			role: "owner",
		};

		let queries = 0;
		const orig = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			queries++;
			return orig(q);
		});

		const metrics = (await getFlowMetrics(ctx, {
			projectId,
			since,
			until,
			granularity: "week",
		})) as {
			cycleTime: { count: number };
			humanInterventions: { count: number; avg: number | null };
			autonomyRatio: { count: number; avg: number | null };
		};
		vi.restoreAllMocks();

		expect(queries).toBeLessThanOrEqual(10);
		expect(metrics.cycleTime.count).toBe(IN_WINDOW);
		expect(metrics.humanInterventions.count).toBe(IN_WINDOW);
		expect(metrics.humanInterventions.avg).toBeCloseTo(0.1);
		expect(metrics.autonomyRatio.count).toBe(IN_WINDOW);
		expect(metrics.autonomyRatio.avg).toBeCloseTo(0.125);
	});
});

describe("PROJ-866 review: window defaults and aging WIP", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, projectId, userId } = await seedProjectFixture({ role: "owner" }));
	});

	async function fetchMetrics(qs: string) {
		return SELF.fetch(`http://localhost/api/projects/${projectId}/flow-metrics?${qs}`, {
			headers: authHeaders(token, slug),
		});
	}

	it("accepts an until-only window in the past (the service's own default since applies)", async () => {
		const now = Math.floor(Date.now() / 1000);
		const res = await fetchMetrics(`until=${now - 90 * 86400}&granularity=day`);
		expect(res.status).toBe(200);
	});

	it("caps an until-only window by its span from the service's default since, not from now", async () => {
		// 340 days ahead is under 366 days from now, but over 366 days from the default
		// bucket start (the Monday 5 weeks before this week's), which is what the service
		// would actually bucket from.
		const now = Math.floor(Date.now() / 1000);
		const res = await fetchMetrics(`until=${now + 340 * 86400}&granularity=day`);
		expect(res.status).toBe(400);
	});

	it("agingWip keeps currently open issues outside the window without changing the windowed series", async () => {
		const DAY = 86400;
		const now = Math.floor(Date.now() / 1000);
		const since = now - 60 * DAY;
		const until = now - 20 * DAY;
		const insert = async (
			title: string,
			stamps: Readonly<{ createdAt: number; claimedAt: number; doneAt: number | null }>
		) => {
			const id = crypto.randomUUID();
			await env.DB.prepare(
				`INSERT INTO issues (id, workspace_id, project_id, number, title, body, status, priority,
					labels, created_by_id, created_at, updated_at, claimed_at, done_at)
				SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, '', 'in_progress', 'none', '[]', ?, ?, ?, ?, ?
				FROM issues WHERE project_id = ?`
			)
				.bind(
					id,
					workspaceId,
					projectId,
					title,
					userId,
					stamps.createdAt,
					stamps.createdAt,
					stamps.claimedAt,
					stamps.doneAt,
					projectId
				)
				.run();
			return id;
		};
		// Created after the (past) `until`, still open now.
		const newer = await insert("Created after until", {
			createdAt: now - 10 * DAY,
			claimedAt: now - 9 * DAY,
			doneAt: null,
		});
		// Reopened: its write-once done_at predates `since`, but it's in progress now.
		const reopened = await insert("Reopened", {
			createdAt: now - 100 * DAY,
			claimedAt: now - 95 * DAY,
			doneAt: now - 90 * DAY,
		});

		const res = await fetchMetrics(`since=${since}&until=${until}&granularity=week`);
		expect(res.status).toBe(200);
		const metrics = (await res.json()) as {
			agingWip: Array<{ id: string }>;
			wipOverTime: Array<{ count: number }>;
			arrivalVsCompletionOverTime: Array<{ created: number; completed: number }>;
			cfdOverTime: Array<{ done: number; inProgress: number }>;
		};
		expect(metrics.agingWip.map((w) => w.id).sort()).toEqual([newer, reopened].sort());
		// Neither issue was active in the window: no WIP, arrivals or completions there,
		// and the reopened one sits in the CFD done band (done before since) only.
		expect(metrics.wipOverTime.every((b) => b.count === 0)).toBe(true);
		expect(
			metrics.arrivalVsCompletionOverTime.every((b) => b.created === 0 && b.completed === 0)
		).toBe(true);
		expect(metrics.cfdOverTime.every((b) => b.done === 1 && b.inProgress === 0)).toBe(true);
	});
});
