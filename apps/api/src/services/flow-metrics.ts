import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray } from "drizzle-orm";
import { GetFlowMetricsSchema } from "../schemas/flow-metrics";
import { effectiveProjectRole, isWorkspaceAdmin } from "./access";
import { NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

interface Distribution {
	count: number;
	avg: number | null;
	p50: number | null;
	p90: number | null;
}

function summarize(durations: number[]): Distribution {
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
};

function buildWipOverTime(
	issues: FlowIssueRow[],
	since: number,
	until: number
): Array<{ date: string; count: number }> {
	const DAY = 86400;
	const buckets: Array<{ date: string; count: number }> = [];
	for (let t = since - (since % DAY); t <= until; t += DAY) {
		const count = issues.filter(
			(i) => i.claimedAt !== null && i.claimedAt <= t && (i.doneAt === null || i.doneAt > t)
		).length;
		buckets.push({ date: new Date(t * 1000).toISOString().slice(0, 10), count });
	}
	return buckets;
}

// Unix epoch day 0 (1970-01-01) was a Thursday; align to the preceding Monday so
// week boundaries read as conventional (ISO) weeks rather than landing on Thursdays.
function mondayAtOrBefore(t: number): number {
	const DAY = 86400;
	const dayIndex = Math.floor(t / DAY);
	const daysSinceMonday = ((dayIndex % 7) + 7 - 4) % 7; // day 0 (Thu) is 4 days after Monday
	return (dayIndex - daysSinceMonday) * DAY;
}

function buildThroughputOverTime(
	issues: FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week"
): Array<{ bucketStart: string; count: number }> {
	const DAY = 86400;
	const bucketSize = granularity === "day" ? DAY : 7 * DAY;
	const firstBucket = granularity === "day" ? since - (since % DAY) : mondayAtOrBefore(since);
	const buckets: Array<{ bucketStart: string; count: number }> = [];
	for (let t = firstBucket; t <= until; t += bucketSize) {
		const bucketEnd = t + bucketSize;
		// Clamp each bucket to the requested window so edge buckets don't pull in
		// completions from just outside [since, until], matching leadTime/cycleTime.
		const clampedStart = Math.max(t, since);
		const clampedEnd = Math.min(bucketEnd, until + 1);
		const count = issues.filter(
			(i) => i.doneAt !== null && i.doneAt >= clampedStart && i.doneAt < clampedEnd
		).length;
		buckets.push({ bucketStart: new Date(t * 1000).toISOString().slice(0, 10), count });
	}
	return buckets;
}

// PROJ-328: review latency (in_review -> done) bucketed the same way as throughput, but
// showing the bucket's p50 rather than a count — the "trend" the ticket asks for.
function buildReviewLatencyOverTime(
	issues: FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week"
): Array<{ bucketStart: string; p50: number | null }> {
	const DAY = 86400;
	const bucketSize = granularity === "day" ? DAY : 7 * DAY;
	const firstBucket = granularity === "day" ? since - (since % DAY) : mondayAtOrBefore(since);
	const buckets: Array<{ bucketStart: string; p50: number | null }> = [];
	for (let t = firstBucket; t <= until; t += bucketSize) {
		const bucketEnd = t + bucketSize;
		const clampedStart = Math.max(t, since);
		const clampedEnd = Math.min(bucketEnd, until + 1);
		const latencies = issues
			.filter(
				(i) =>
					i.inReviewAt !== null &&
					i.doneAt !== null &&
					i.doneAt >= clampedStart &&
					i.doneAt < clampedEnd
			)
			// biome-ignore lint/style/noNonNullAssertion: filtered above
			.map((i) => i.doneAt! - i.inReviewAt!);
		buckets.push({
			bucketStart: new Date(t * 1000).toISOString().slice(0, 10),
			p50: summarize(latencies).p50,
		});
	}
	return buckets;
}

// PROJ-329: cumulative flow diagram bands, sampled at each bucket start from the
// write-once transition timestamps. An issue's band at time t is the furthest stage
// it has reached by t (done > in_review > in_progress > backlog/todo); the done band
// is therefore monotonic non-decreasing (an issue never leaves it), which is what
// makes CFD bands readable as a choke-point signal.
function buildCfdOverTime(
	issues: FlowIssueRow[],
	since: number,
	until: number,
	granularity: "day" | "week"
): Array<{
	bucketStart: string;
	backlogTodo: number;
	inProgress: number;
	inReview: number;
	done: number;
}> {
	const DAY = 86400;
	const bucketSize = granularity === "day" ? DAY : 7 * DAY;
	const firstBucket = granularity === "day" ? since - (since % DAY) : mondayAtOrBefore(since);
	const buckets: Array<{
		bucketStart: string;
		backlogTodo: number;
		inProgress: number;
		inReview: number;
		done: number;
	}> = [];
	for (let t = firstBucket; t <= until; t += bucketSize) {
		let backlogTodo = 0;
		let inProgress = 0;
		let inReview = 0;
		let done = 0;
		for (const i of issues) {
			if (i.createdAt > t) continue;
			if (i.doneAt !== null && i.doneAt <= t) done++;
			else if (i.inReviewAt !== null && i.inReviewAt <= t) inReview++;
			else if (i.claimedAt !== null && i.claimedAt <= t) inProgress++;
			else backlogTodo++;
		}
		buckets.push({
			bucketStart: new Date(t * 1000).toISOString().slice(0, 10),
			backlogTodo,
			inProgress,
			inReview,
			done,
		});
	}
	return buckets;
}

// PROJ-328: human-authored comments per issue, keyed by the ctx.authKind stamped at
// write time (comments.ts) — not the deprecated agent_sessions.kind. Rows written before
// that column existed have author_kind NULL and are excluded rather than guessed.
async function fetchHumanCommentCounts(
	orm: ReturnType<typeof drizzle>,
	issueIds: string[]
): Promise<Map<string, number>> {
	const rows = await inChunks(issueIds, (chunk) =>
		orm
			.select({ issueId: schema.issueComments.issueId })
			.from(schema.issueComments)
			.where(
				and(
					inArray(schema.issueComments.issueId, chunk),
					eq(schema.issueComments.authorKind, "human")
				)
			)
	);
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.issueId, (counts.get(row.issueId) ?? 0) + 1);
	return counts;
}

// PROJ-328: total lease-held seconds per issue, from issue_leases (already the
// authoritative "an agent worked this issue" record — see issue-leases.ts). A lease
// still held when the issue finished counts through doneAt, not "now".
async function fetchLeaseHeldSeconds(
	orm: ReturnType<typeof drizzle>,
	issues: FlowIssueRow[]
): Promise<Map<string, number>> {
	const doneAtById = new Map(issues.map((i) => [i.id, i.doneAt]));
	const rows = await inChunks(
		issues.map((i) => i.id),
		(chunk) =>
			orm
				.select({
					issueId: schema.issueLeases.issueId,
					claimedAt: schema.issueLeases.claimedAt,
					releasedAt: schema.issueLeases.releasedAt,
				})
				.from(schema.issueLeases)
				.where(inArray(schema.issueLeases.issueId, chunk))
	);
	const held = new Map<string, number>();
	for (const row of rows) {
		const end = row.releasedAt ?? doneAtById.get(row.issueId) ?? null;
		if (end === null) continue;
		const seconds = Math.max(0, end - row.claimedAt);
		held.set(row.issueId, (held.get(row.issueId) ?? 0) + seconds);
	}
	return held;
}

// PROJ-328: human interventions per completed issue = human comments + status bounces
// out of review. The primary "how much human attention did this take" signal.
function computeHumanInterventions(
	issues: FlowIssueRow[],
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
	issues: FlowIssueRow[],
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

export async function getFlowMetrics(ctx: ServiceCtx, raw: unknown) {
	const result = GetFlowMetricsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { projectId, since, until, granularity } = result.data;

	await assertProjectExists(ctx, projectId);

	const orm = drizzle(ctx.db, { schema });

	// Scope by project only, not created_at: since/until describe an activity window
	// (claimed/done), and an issue created before the window but active inside it must
	// still count (e.g. WIP). Row count stays bounded by project size.
	const issues = await orm
		.select({
			id: schema.issues.id,
			createdAt: schema.issues.createdAt,
			readyAt: schema.issues.readyAt,
			claimedAt: schema.issues.claimedAt,
			doneAt: schema.issues.doneAt,
			inReviewAt: schema.issues.inReviewAt,
			reviewBounceCount: schema.issues.reviewBounceCount,
		})
		.from(schema.issues)
		.where(
			and(eq(schema.issues.workspaceId, ctx.workspaceId), eq(schema.issues.projectId, projectId))
		);

	const inWindow = (t: number) =>
		(since === undefined || t >= since) && (until === undefined || t <= until);

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

	const issueIds = issues.map((i) => i.id);
	const humanCommentCounts = await fetchHumanCommentCounts(orm, issueIds);
	const leaseHeldSeconds = await fetchLeaseHeldSeconds(orm, issues);
	const humanInterventions = computeHumanInterventions(issues, humanCommentCounts, inWindow);
	const autonomyRatios = computeAutonomyRatios(issues, leaseHeldSeconds, inWindow);

	const now = Math.floor(Date.now() / 1000);
	const wipSince = since ?? now - 30 * 86400;
	const wipUntil = until ?? now;
	const wipOverTime = buildWipOverTime(issues, wipSince, wipUntil);

	// Default window = the current ISO week plus the preceding 5 weeks (6 weeks total).
	const throughputSince = since ?? mondayAtOrBefore(now) - 5 * 7 * 86400;
	const throughputUntil = until ?? now;
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
	const cfdOverTime = buildCfdOverTime(issues, throughputSince, throughputUntil, granularity);

	return {
		leadTime: summarize(leadTimes),
		cycleTime: summarize(cycleTimes),
		wipOverTime,
		throughputOverTime,
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
	};
}
