import { drizzle, schema } from "@projektor/db";
import {
	and,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import {
	flowMetricsDefaultStarts,
	GetFlowMetricsSchema,
	mondayAtOrBefore,
} from "../schemas/flow-metrics";
import { effectiveProjectRole, isWorkspaceAdmin } from "./access";
import { NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

export interface Distribution {
	count: number;
	avg: number | null;
	p50: number | null;
	p90: number | null;
}

function summarize(durations: readonly number[]): Distribution {
	if (durations.length === 0) return { count: 0, avg: null, p50: null, p90: null };
	const sorted = [...durations].sort((a, b) => a - b);
	const avg = sorted.reduce((sum, d) => sum + d, 0) / sorted.length;
	const percentile = (p: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
	return { count: sorted.length, avg, p50: percentile(0.5), p90: percentile(0.9) };
}

async function assertProjectExists(ctx: ServiceCtx, projectId: string): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	const project = await orm
		.select({ id: schema.projects.id })
		.from(schema.projects)
		.where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!project) throw new NotFoundError("Project not found");
	// PROJ-311: a non-admin without a grant can't see the project's metrics.
	if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
		throw new NotFoundError("Project not found");
	}
}

type FlowIssueRow = {
	id: string;
	createdAt: number;
	readyAt: number | null;
	claimedAt: number | null;
	doneAt: number | null;
	inReviewAt: number | null;
	reviewBounceCount: number;
	status: string;
	typeKey: string | null;
};

const DAY = 86400;

function dateLabel(t: number): string {
	return new Date(t * 1000).toISOString().slice(0, 10);
}

function bucketSizeFor(granularity: "day" | "week"): number {
	return granularity === "day" ? DAY : 7 * DAY;
}

function firstBucketFor(since: number, granularity: "day" | "week"): number {
	return granularity === "day" ? since - (since % DAY) : mondayAtOrBefore(since);
}

// PROJ-866: bucket start times only — bounded by the schema's max-window validation,
// so this list itself is now always small (<=366 for day, <=~261 for week) regardless
// of what the caller passes.
function buildBucketStarts(since: number, until: number, granularity: "day" | "week"): number[] {
	const bucketSize = bucketSizeFor(granularity);
	const starts: number[] = [];
	for (let t = firstBucketFor(since, granularity); t <= until; t += bucketSize) {
		starts.push(t);
	}
	return starts;
}

// Each bucket's *effective* range, clamped to [since, until] so an aligned edge bucket
// doesn't pull in events from just outside the requested window (matches leadTime/
// cycleTime's inWindow semantics exactly).
function bucketRanges(
	starts: readonly number[],
	bucketSize: number,
	since: number,
	until: number
): Array<{ start: number; end: number }> {
	return starts.map((t) => ({
		start: Math.max(t, since),
		end: Math.min(t + bucketSize, until + 1),
	}));
}

// PROJ-866: assign each item to its bucket in one pass over the SORTED item list plus
// one pass over the (already small, bounded) bucket ranges — O(n log n + buckets)
// instead of the old O(buckets * n) (filtering every issue per bucket). Ranges must be
// non-decreasing and non-overlapping in `start`/`end` (true for bucketRanges() above,
// since consecutive buckets are contiguous and since/until only clamp the two edges).
function groupBySortedRanges<T>(
	items: readonly T[],
	time: (item: T) => number,
	ranges: ReadonlyArray<{ start: number; end: number }>
): T[][] {
	const sorted = [...items].sort((a, b) => time(a) - time(b));
	const groups: T[][] = ranges.map(() => []);
	let idx = 0;
	for (let r = 0; r < ranges.length; r++) {
		const { start, end } = ranges[r];
		while (idx < sorted.length && time(sorted[idx]) < start) idx++;
		let j = idx;
		while (j < sorted.length && time(sorted[j]) < end) {
			groups[r].push(sorted[j]);
			j++;
		}
		idx = j;
	}
	return groups;
}

function buildWipOverTime(
	issues: readonly FlowIssueRow[],
	since: number,
	until: number
): Array<{ date: string; count: number }> {
	// PROJ-866: WIP-at-time-t is an interval-containment count (active during
	// [claimedAt, doneAt)). Instead of re-filtering every issue at every sampled day,
	// turn each issue into at most two delta events (+1 at claimedAt, -1 at doneAt) and
	// sweep a single running total across the sorted events as `t` advances — the
	// buckets loop and the event list are each walked once.
	const events: Array<[number, number]> = [];
	for (const i of issues) {
		if (i.claimedAt === null) continue;
		events.push([i.claimedAt, 1]);
		if (i.doneAt !== null) events.push([i.doneAt, -1]);
	}
	events.sort((a, b) => a[0] - b[0]);

	const buckets: Array<{ date: string; count: number }> = [];
	let idx = 0;
	let running = 0;
	for (let t = since - (since % DAY); t <= until; t += DAY) {
		while (idx < events.length && events[idx][0] <= t) {
			running += events[idx][1];
			idx++;
		}
		buckets.push({ date: dateLabel(t), count: running });
	}
	return buckets;
}

function buildThroughputOverTime(
	issues: readonly FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week"
): Array<{ bucketStart: string; count: number }> {
	const bucketSize = bucketSizeFor(granularity);
	const starts = buildBucketStarts(since, until, granularity);
	const ranges = bucketRanges(starts, bucketSize, since, until);
	const completed = issues.filter((i): i is FlowIssueRow & { doneAt: number } => i.doneAt !== null);
	const groups = groupBySortedRanges(completed, (i) => i.doneAt, ranges);
	return starts.map((t, idx) => ({ bucketStart: dateLabel(t), count: groups[idx].length }));
}

// PROJ-331: bug share of throughput, bucketed the same way as throughput. Untyped issues
// (typeKey null) count toward the bucket total (so they aren't silently dropped from the
// denominator) but never toward bugCount — "untyped" is treated as "not a bug", the same
// as any other non-bug type. bugSharePercent is null (not 0) when a bucket completed
// nothing, so an empty bucket reads as "no data" rather than "zero defects".
function buildBugShareOverTime(
	issues: readonly FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week"
): Array<{ bucketStart: string; total: number; bugCount: number; bugSharePercent: number | null }> {
	const bucketSize = bucketSizeFor(granularity);
	const starts = buildBucketStarts(since, until, granularity);
	const ranges = bucketRanges(starts, bucketSize, since, until);
	const completed = issues.filter((i): i is FlowIssueRow & { doneAt: number } => i.doneAt !== null);
	const groups = groupBySortedRanges(completed, (i) => i.doneAt, ranges);
	return starts.map((t, idx) => {
		const group = groups[idx];
		const bugCount = group.filter((i) => i.typeKey === "bug").length;
		return {
			bucketStart: dateLabel(t),
			total: group.length,
			bugCount,
			bugSharePercent: group.length > 0 ? bugCount / group.length : null,
		};
	});
}

// PROJ-328: review latency (in_review -> done) bucketed the same way as throughput, but
// showing the bucket's p50 rather than a count — the "trend" the ticket asks for.
function buildReviewLatencyOverTime(
	issues: readonly FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week"
): Array<{ bucketStart: string; p50: number | null }> {
	const bucketSize = bucketSizeFor(granularity);
	const starts = buildBucketStarts(since, until, granularity);
	const ranges = bucketRanges(starts, bucketSize, since, until);
	const reviewed = issues.filter(
		(i): i is FlowIssueRow & { doneAt: number; inReviewAt: number } =>
			i.doneAt !== null && i.inReviewAt !== null
	);
	const groups = groupBySortedRanges(reviewed, (i) => i.doneAt, ranges);
	return starts.map((t, idx) => ({
		bucketStart: dateLabel(t),
		p50: summarize(groups[idx].map((i) => i.doneAt - i.inReviewAt)).p50,
	}));
}

// PROJ-330: arrival vs completion — issues created vs issues completed per bucket, plus
// the net (created - completed), bucketed the same way as throughput. Answers "is the
// backlog growing or burning?" at a glance.
function buildArrivalVsCompletion(
	issues: readonly FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week"
): Array<{ bucketStart: string; created: number; completed: number; net: number }> {
	const bucketSize = bucketSizeFor(granularity);
	const starts = buildBucketStarts(since, until, granularity);
	const ranges = bucketRanges(starts, bucketSize, since, until);
	const createdGroups = groupBySortedRanges(issues, (i) => i.createdAt, ranges);
	const completed = issues.filter((i): i is FlowIssueRow & { doneAt: number } => i.doneAt !== null);
	const completedGroups = groupBySortedRanges(completed, (i) => i.doneAt, ranges);
	return starts.map((t, idx) => {
		const created = createdGroups[idx].length;
		const done = completedGroups[idx].length;
		return { bucketStart: dateLabel(t), created, completed: done, net: created - done };
	});
}

// An issue's CFD band at a given sample instant is the furthest stage it has reached
// by then (done > in_review > in_progress > backlog/todo), or excluded entirely if it
// wasn't created yet. Order of checks matters: this is what makes the done band
// monotonic non-decreasing (an issue never leaves it) once it's reached.
type CfdBand = "excluded" | "backlogTodo" | "inProgress" | "inReview" | "done";

function classifyCfdBand(issue: FlowIssueRow, sampleAt: number): CfdBand {
	if (issue.createdAt > sampleAt) return "excluded";
	if (issue.doneAt !== null && issue.doneAt <= sampleAt) return "done";
	if (issue.inReviewAt !== null && issue.inReviewAt <= sampleAt) return "inReview";
	if (issue.claimedAt !== null && issue.claimedAt <= sampleAt) return "inProgress";
	return "backlogTodo";
}

// PROJ-866: precompute each issue's band-transition events instead of re-classifying
// every issue at every sampled instant. classifyCfdBand is evaluated only at each
// issue's OWN distinct timestamps (at most 4) — reusing the exact same priority logic
// above, so this is not a re-derivation that could drift from it, just memoizing where
// the band actually changes for that one issue. The resulting per-issue event list is
// correct regardless of whether an issue's timestamps happen to be in the "expected"
// created <= claimed <= in_review <= done order.
function buildCfdEvents(
	issues: readonly FlowIssueRow[]
): Array<{ time: number; band: Exclude<CfdBand, "excluded">; delta: 1 | -1 }> {
	const events: Array<{ time: number; band: Exclude<CfdBand, "excluded">; delta: 1 | -1 }> = [];
	for (const issue of issues) {
		const thresholds = [
			...new Set(
				[issue.createdAt, issue.claimedAt, issue.inReviewAt, issue.doneAt].filter(
					(t): t is number => t !== null
				)
			),
		].sort((a, b) => a - b);
		let prevBand: CfdBand = "excluded";
		for (const t of thresholds) {
			const band = classifyCfdBand(issue, t);
			if (band === prevBand) continue;
			if (prevBand !== "excluded") events.push({ time: t, band: prevBand, delta: -1 });
			if (band !== "excluded") events.push({ time: t, band, delta: 1 });
			prevBand = band;
		}
	}
	events.sort((a, b) => a.time - b.time);
	return events;
}

// PROJ-329: cumulative flow diagram bands, sampled at each bucket's end (clamped to
// `until`/`now`) from the write-once transition timestamps.
//
// PROJ-377: sampling at the bucket's *end* (not its start) matters for the always-
// partial current bucket — a bucket-start sample lands before any activity in that
// bucket has happened, so a bucket-worth of newly created/completed issues reads as
// all zeros even though `arrivalVsCompletionOverTime` (which counts events across the
// whole bucket range) shows them. `now` additionally clamps so we never sample into
// the future when `until` extends past the present.
//
// PROJ-866: one pass over the (small, per-issue) event list instead of reclassifying
// every issue at every bucket — the sampleAt sequence is non-decreasing across buckets
// (each is min(bucket-end, until, now)), so a single running-counts object plus a
// monotonic pointer into the sorted event list reproduces exactly what re-running
// classifyCfdBand per bucket would have produced.
function buildCfdOverTime(
	issues: readonly FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week",
	now: number,
	doneBeforeWindow: number
): Array<{
	bucketStart: string;
	backlogTodo: number;
	inProgress: number;
	inReview: number;
	done: number;
}> {
	const bucketSize = bucketSizeFor(granularity);
	const starts = buildBucketStarts(since, until, granularity);
	const events = buildCfdEvents(issues);
	// PROJ-866: issues done before the SQL window's lower bound aren't loaded, but they
	// are in the done band at every sample (each sample is >= that bound), so the band
	// starts from their count instead of zero.
	const counts = { backlogTodo: 0, inProgress: 0, inReview: 0, done: doneBeforeWindow };
	let idx = 0;
	return starts.map((t) => {
		const sampleAt = Math.min(t + bucketSize - 1, until, now);
		while (idx < events.length && events[idx].time <= sampleAt) {
			counts[events[idx].band] += events[idx].delta;
			idx++;
		}
		return { bucketStart: dateLabel(t), ...counts };
	});
}

// PROJ-866: the per-issue lookups below join back to `issues` on the same project scope
// plus `doneInWindow` (see getFlowMetrics) instead of binding an issue-id IN-list, so
// each is one statement however many issues the window holds. doneInWindow is exactly
// the set their consumers read: humanInterventions, autonomyRatio and flowEfficiency
// all only look at issues done inside the window.

// PROJ-328: human-authored comments per issue, keyed by the ctx.authKind stamped at
// write time (comments.ts) — not the deprecated agent_sessions.kind. Rows written before
// that column existed have author_kind NULL and are excluded rather than guessed.
async function fetchHumanCommentCounts(
	orm: ReturnType<typeof drizzle>,
	issueScope: SQL
): Promise<Map<string, number>> {
	const rows = await orm
		.select({ issueId: schema.issueComments.issueId, n: sql<number>`count(*)` })
		.from(schema.issueComments)
		.innerJoin(schema.issues, eq(schema.issueComments.issueId, schema.issues.id))
		.where(and(issueScope, eq(schema.issueComments.authorKind, "human")))
		.groupBy(schema.issueComments.issueId);
	return new Map(rows.map((r) => [r.issueId, Number(r.n)]));
}

// PROJ-328: total lease-held seconds per issue, from issue_leases (already the
// authoritative "an agent worked this issue" record — see issue-leases.ts). A lease
// still held when the issue finished counts through doneAt, not "now".
//
// PROJ-866/F-P2: issue_leases.workspace_id is filtered too, so the lease side of the
// join is tenant-scoped like every other cross-tenant read and can use its indexes.
async function fetchLeaseHeldSeconds(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	issueScope: SQL
): Promise<Map<string, number>> {
	const rows = await orm
		.select({
			issueId: schema.issueLeases.issueId,
			claimedAt: schema.issueLeases.claimedAt,
			releasedAt: schema.issueLeases.releasedAt,
			doneAt: schema.issues.doneAt,
		})
		.from(schema.issueLeases)
		.innerJoin(schema.issues, eq(schema.issueLeases.issueId, schema.issues.id))
		.where(and(eq(schema.issueLeases.workspaceId, ctx.workspaceId), issueScope));
	const held = new Map<string, number>();
	for (const row of rows) {
		const end = row.releasedAt ?? row.doneAt ?? null;
		if (end === null) continue;
		const seconds = Math.max(0, end - row.claimedAt);
		held.set(row.issueId, (held.get(row.issueId) ?? 0) + seconds);
	}
	return held;
}

function computeCoreDistributions(
	issues: readonly FlowIssueRow[],
	inWindow: (t: number) => boolean
): {
	leadTimes: number[];
	cycleTimes: number[];
	reviewLatencies: number[];
	timeInProgress: number[];
} {
	const leadTimes = issues
		.filter((i) => i.readyAt !== null && i.doneAt !== null && inWindow(i.doneAt))
		// biome-ignore lint/style/noNonNullAssertion: filtered above
		.map((i) => i.doneAt! - i.readyAt!);
	const cycleTimes = issues
		.filter((i) => i.claimedAt !== null && i.doneAt !== null && inWindow(i.doneAt))
		// biome-ignore lint/style/noNonNullAssertion: filtered above
		.map((i) => i.doneAt! - i.claimedAt!);
	const reviewLatencies = issues
		.filter((i) => i.inReviewAt !== null && i.doneAt !== null && inWindow(i.doneAt))
		// biome-ignore lint/style/noNonNullAssertion: filtered above
		.map((i) => i.doneAt! - i.inReviewAt!);
	// PROJ-329: time in in_progress = claimed -> the issue's next recorded stage
	// (entering review, or done directly for issues that skipped review).
	const timeInProgress = issues
		.filter((i) => i.claimedAt !== null && i.doneAt !== null && inWindow(i.doneAt))
		// biome-ignore lint/style/noNonNullAssertion: filtered above
		.map((i) => (i.inReviewAt ?? i.doneAt!) - i.claimedAt!);
	return { leadTimes, cycleTimes, reviewLatencies, timeInProgress };
}

// PROJ-328: human interventions per completed issue = human comments + status bounces
// out of review. The primary "how much human attention did this take" signal.
function computeHumanInterventions(
	issues: readonly FlowIssueRow[],
	humanCommentCounts: Map<string, number>,
	inWindow: (t: number) => boolean
): number[] {
	return issues
		.filter((i) => i.doneAt !== null && inWindow(i.doneAt))
		.map((i) => (humanCommentCounts.get(i.id) ?? 0) + i.reviewBounceCount);
}

// PROJ-328: autonomy ratio per completed issue = lease-held time / cycle time. Clamped
// to [0, 1] — sequential re-leases can sum close to the full cycle but shouldn't exceed it.
function computeAutonomyRatios(
	issues: readonly FlowIssueRow[],
	leaseHeldSeconds: Map<string, number>,
	inWindow: (t: number) => boolean
): number[] {
	return issues
		.filter((i) => i.claimedAt !== null && i.doneAt !== null && inWindow(i.doneAt))
		.map((i) => {
			// biome-ignore lint/style/noNonNullAssertion: filtered above
			const cycle = i.doneAt! - i.claimedAt!;
			if (cycle <= 0) return 0;
			const held = leaseHeldSeconds.get(i.id) ?? 0;
			return Math.min(1, held / cycle);
		});
}

// PROJ-330: flow efficiency per completed issue = lease-held time / lead time (lead time
// = done - ready, i.e. time since the issue was ready to work, not since it was claimed).
// This is deliberately distinct from PROJ-328's autonomyRatio (lease-held / cycle time =
// done - claimed): flow efficiency also counts queueing time between ready and claimed as
// "waste", so it's always <= autonomyRatio for the same issue. Clamped to [0, 1] for the
// same reason as autonomyRatio (sequential re-leases can sum close to the full lead time).
function computeFlowEfficiencies(
	issues: readonly FlowIssueRow[],
	leaseHeldSeconds: Map<string, number>,
	inWindow: (t: number) => boolean
): number[] {
	return issues
		.filter((i) => i.readyAt !== null && i.doneAt !== null && inWindow(i.doneAt))
		.map((i) => {
			// biome-ignore lint/style/noNonNullAssertion: filtered above
			const leadTime = i.doneAt! - i.readyAt!;
			if (leadTime <= 0) return 0;
			const held = leaseHeldSeconds.get(i.id) ?? 0;
			return Math.min(1, held / leadTime);
		});
}

// PROJ-330: aging-WIP scatter — every currently open (in_progress/in_review) issue with
// its age since claim. Not scoped to since/until (it's a present-state snapshot, not a
// historical series — PROJ-866 loads open issues past the window bounds for it alone); the p50/p90 reference lines the UI overlays come from the window-
// scoped cycleTime distribution already returned alongside this, so the chart still
// reflects the shared date-range controls. Surfaces items stuck long enough to be worth
// investigating before they finish and pollute the cycle-time percentiles.
function buildAgingWip(
	issues: readonly FlowIssueRow[],
	now: number
): Array<{ id: string; status: "in_progress" | "in_review"; ageSeconds: number }> {
	return issues
		.filter(
			(i): i is FlowIssueRow & { claimedAt: number } =>
				i.claimedAt !== null && (i.status === "in_progress" || i.status === "in_review")
		)
		.map((i) => ({
			id: i.id,
			status: i.status as "in_progress" | "in_review",
			ageSeconds: now - i.claimedAt,
		}));
}

// PROJ-334: factory-health tiles — fault signals for the machinery itself, not the
// work. Each count is windowed by when the fault EVENT happened (released_at /
// occurred_at), not by an issue's doneAt like the distribution tiles above, since a
// lease expiry or abandoned claim can happen on an issue that never completes in this
// window (or ever). All counts are project-scoped the same way the rest of this
// endpoint is.
interface FactoryHealth {
	leaseExpiries: number;
	abandonedClaims: number;
	gateRejections: number;
	wipCapPressure: number;
}

// PROJ-866: the four factory-health counts and the CFD's done-before-window count are
// independent scalar COUNT(*)s, so they run as subqueries of one statement (anchored on
// the project row) instead of five round trips that each fetched every matching row.
async function fetchWindowCounts(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	projectId: string,
	opts: Readonly<{
		since: number;
		until: number;
		doneBefore: number | undefined;
		createdUntil: number;
	}>
): Promise<FactoryHealth & { doneBeforeWindow: number }> {
	const { since, until } = opts;
	const countOf = (query: SQLWrapper) => sql<number>`(${query})`;
	const count = sql<number>`count(*)`;
	const row = await orm
		.select({
			leaseExpiries: countOf(
				orm
					.select({ n: count })
					.from(schema.issueLeases)
					.innerJoin(schema.issues, eq(schema.issueLeases.issueId, schema.issues.id))
					.where(
						and(
							eq(schema.issueLeases.workspaceId, ctx.workspaceId),
							eq(schema.issues.projectId, projectId),
							eq(schema.issueLeases.releaseReason, "expired"),
							gte(schema.issueLeases.releasedAt, since),
							lte(schema.issueLeases.releasedAt, until)
						)
					)
			),
			abandonedClaims: countOf(
				orm
					.select({ n: count })
					.from(schema.issueFileClaims)
					.innerJoin(schema.issues, eq(schema.issueFileClaims.issueId, schema.issues.id))
					.where(
						and(
							eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
							eq(schema.issues.projectId, projectId),
							eq(schema.issueFileClaims.releaseReason, "agent_ended"),
							gte(schema.issueFileClaims.releasedAt, since),
							lte(schema.issueFileClaims.releasedAt, until)
						)
					)
			),
			gateRejections: countOf(
				orm
					.select({ n: count })
					.from(schema.issueGateRejections)
					.innerJoin(schema.issues, eq(schema.issueGateRejections.issueId, schema.issues.id))
					.where(
						and(
							eq(schema.issueGateRejections.workspaceId, ctx.workspaceId),
							eq(schema.issues.projectId, projectId),
							gte(schema.issueGateRejections.occurredAt, since),
							lte(schema.issueGateRejections.occurredAt, until)
						)
					)
			),
			// PROJ-342: WIP-cap denials — claims rejected for hitting the per-project agent
			// WIP cap. Recorded at the denial site in claimIssue (services/issue-leases.ts).
			wipCapPressure: countOf(
				orm
					.select({ n: count })
					.from(schema.wipCapDenials)
					.where(
						and(
							eq(schema.wipCapDenials.workspaceId, ctx.workspaceId),
							eq(schema.wipCapDenials.projectId, projectId),
							gte(schema.wipCapDenials.occurredAt, since),
							lte(schema.wipCapDenials.occurredAt, until)
						)
					)
			),
			doneBeforeWindow:
				opts.doneBefore === undefined
					? sql<number>`0`
					: countOf(
							orm
								.select({ n: count })
								.from(schema.issues)
								.where(
									and(
										eq(schema.issues.workspaceId, ctx.workspaceId),
										eq(schema.issues.projectId, projectId),
										lte(schema.issues.createdAt, opts.createdUntil),
										sql`${schema.issues.doneAt} < ${opts.doneBefore}`
									)
								)
						),
		})
		.from(schema.projects)
		.where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();

	return {
		leaseExpiries: Number(row?.leaseExpiries ?? 0),
		abandonedClaims: Number(row?.abandonedClaims ?? 0),
		gateRejections: Number(row?.gateRejections ?? 0),
		wipCapPressure: Number(row?.wipCapPressure ?? 0),
		doneBeforeWindow: Number(row?.doneBeforeWindow ?? 0),
	};
}

export async function getFlowMetrics(ctx: ServiceCtx, raw: unknown) {
	const result = GetFlowMetricsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { projectId, since, until, granularity } = result.data;

	await assertProjectExists(ctx, projectId);

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);

	const defaults = flowMetricsDefaultStarts(now);
	const wipSince = since ?? defaults.wipSince;
	const wipUntil = until ?? now;
	// Default window = the current ISO week plus the preceding 5 weeks (6 weeks total).
	const throughputSince = since ?? defaults.bucketSince;
	const throughputUntil = until ?? now;

	// PROJ-866: scope the issue SELECT to the window instead of loading every issue in
	// the project.
	// - created_at <= until (or now): an issue created later can't have entered any
	//   stage by `until`, so no windowed series wants it.
	// - done_at >= doneBefore, only when `since` is given (when it's omitted, leadTime/
	//   cycleTime are deliberately unbounded, see inWindow below). doneBefore is the
	//   start of wipOverTime's first day bucket, not `since` itself: that bucket samples
	//   at the day start, so an issue done between it and `since` still counts as WIP
	//   there. Issues done before doneBefore are in the CFD done band at every sample;
	//   they're counted (fetchWindowCounts) rather than loaded.
	const createdUntil = until ?? now;
	const doneBefore = since === undefined ? undefined : Math.min(since, since - (since % DAY));
	const windowPredicate = and(
		lte(schema.issues.createdAt, createdUntil),
		doneBefore === undefined
			? undefined
			: or(isNull(schema.issues.doneAt), gte(schema.issues.doneAt, doneBefore))
	);
	const inSqlWindow = (i: FlowIssueRow) =>
		i.createdAt <= createdUntil &&
		(doneBefore === undefined || i.doneAt === null || i.doneAt >= doneBefore);
	const projectScope = and(
		eq(schema.issues.workspaceId, ctx.workspaceId),
		eq(schema.issues.projectId, projectId)
	);

	const loaded = await orm
		.select({
			id: schema.issues.id,
			createdAt: schema.issues.createdAt,
			readyAt: schema.issues.readyAt,
			claimedAt: schema.issues.claimedAt,
			doneAt: schema.issues.doneAt,
			inReviewAt: schema.issues.inReviewAt,
			reviewBounceCount: schema.issues.reviewBounceCount,
			status: schema.issues.status,
			typeKey: schema.taskTypes.key,
		})
		.from(schema.issues)
		.leftJoin(schema.taskTypes, eq(schema.issues.typeId, schema.taskTypes.id))
		.where(
			and(
				projectScope,
				// Currently open issues are also loaded whatever their dates, for the
				// present-state agingWip snapshot only (a reopened issue keeps its old
				// write-once done_at, and one created after a past `until` is still open
				// now). They're filtered back out below for every windowed series.
				or(windowPredicate, inArray(schema.issues.status, ["in_progress", "in_review"]))
			)
		);
	const issues = loaded.filter(inSqlWindow);

	// Scope by project only, not created_at: since/until describe an activity window
	// (claimed/done), and an issue created before the window but active inside it must
	// still count (e.g. WIP). Row count stays bounded by the window (via the SQL filter
	// above) rather than total project size.
	const inWindow = (t: number) =>
		(since === undefined || t >= since) && (until === undefined || t <= until);

	const { leadTimes, cycleTimes, reviewLatencies, timeInProgress } = computeCoreDistributions(
		issues,
		inWindow
	);

	// The issues the per-issue comment/lease lookups serve: done inside the window.
	const doneInWindowScope = and(
		projectScope,
		isNotNull(schema.issues.doneAt),
		since === undefined ? undefined : gte(schema.issues.doneAt, since),
		until === undefined ? undefined : lte(schema.issues.doneAt, until)
	);
	// Never let the per-issue lookups run without a tenant scope.
	if (!doneInWindowScope) throw new Error("flow-metrics: missing issue scope");

	// PROJ-446: everything below depends only on the window bounds plus ctx/projectId —
	// none of these reads depend on each other, so run them concurrently instead of one
	// round trip at a time.
	const [humanCommentCounts, leaseHeldSeconds, bugTypeExists, windowCounts] = await Promise.all([
		fetchHumanCommentCounts(orm, doneInWindowScope),
		fetchLeaseHeldSeconds(orm, ctx, doneInWindowScope),
		// PROJ-341: buildBugShareOverTime identifies bugs via typeKey === "bug" — if the
		// workspace has no type keyed "bug" (renamed/deleted default), that always reads 0%
		// with no indication anything's wrong. Surface whether the type exists at all so the
		// frontend can show a distinguishable "not tracked" state instead of a silent 0%.
		orm
			.select({ id: schema.taskTypes.id })
			.from(schema.taskTypes)
			.where(
				and(eq(schema.taskTypes.workspaceId, ctx.workspaceId), eq(schema.taskTypes.key, "bug"))
			)
			.get(),
		// PROJ-334: same window as the throughput/CFD/etc. buckets below — the "selected
		// window" the tile row is scoped to.
		fetchWindowCounts(orm, ctx, projectId, {
			since: throughputSince,
			until: throughputUntil,
			doneBefore,
			createdUntil,
		}),
	]);
	const { doneBeforeWindow, ...factoryHealth } = windowCounts;

	const humanInterventions = computeHumanInterventions(issues, humanCommentCounts, inWindow);
	const autonomyRatios = computeAutonomyRatios(issues, leaseHeldSeconds, inWindow);
	const wipOverTime = buildWipOverTime(issues, wipSince, wipUntil);
	const throughputOverTime = buildThroughputOverTime(
		issues,
		throughputSince,
		throughputUntil,
		granularity
	);
	const reviewLatencyOverTime = buildReviewLatencyOverTime(
		issues,
		throughputSince,
		throughputUntil,
		granularity
	);
	const cfdOverTime = buildCfdOverTime(
		issues,
		throughputSince,
		throughputUntil,
		granularity,
		now,
		doneBeforeWindow
	);
	const bugShareOverTime = buildBugShareOverTime(
		issues,
		throughputSince,
		throughputUntil,
		granularity
	);
	const bugTypeTracked = bugTypeExists !== undefined;
	const arrivalVsCompletionOverTime = buildArrivalVsCompletion(
		issues,
		throughputSince,
		throughputUntil,
		granularity
	);
	const flowEfficiencies = computeFlowEfficiencies(issues, leaseHeldSeconds, inWindow);
	const agingWip = buildAgingWip(loaded, now);

	return {
		leadTime: summarize(leadTimes),
		cycleTime: summarize(cycleTimes),
		wipOverTime,
		throughputOverTime,
		// PROJ-331: bug share of throughput — a rising share signals the factory shipping
		// more defects, not just more work.
		bugShareOverTime,
		// PROJ-341: whether a "bug"-keyed task type exists in the workspace at all —
		// distinguishes "tracked, 0 bugs" from "not tracked, no matching type".
		bugTypeTracked,
		// PROJ-328: collaboration-shape metrics. reviewLatency is the primary human
		// choke point (in_review -> done); humanInterventions and autonomyRatio are
		// aggregated per completed issue.
		reviewLatency: summarize(reviewLatencies),
		reviewLatencyOverTime,
		humanInterventions: summarize(humanInterventions),
		autonomyRatio: summarize(autonomyRatios),
		// PROJ-329: cumulative flow diagram + time-in-state breakdown.
		cfdOverTime,
		timeInProgress: summarize(timeInProgress),
		// PROJ-330: arrival vs completion, flow efficiency, aging-WIP scatter.
		arrivalVsCompletionOverTime,
		flowEfficiency: summarize(flowEfficiencies),
		agingWip,
		// PROJ-334: factory health — fault signals for the machinery itself.
		factoryHealth,
	};
}
