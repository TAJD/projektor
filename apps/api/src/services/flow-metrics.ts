import { drizzle, schema } from "@projektor/db";
import { and, eq } from "drizzle-orm";
import { GetFlowMetricsSchema } from "../schemas/flow-metrics";
import { NotFoundError, ValidationError } from "./errors";
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
}

type FlowIssueRow = {
	id: string;
	readyAt: number | null;
	claimedAt: number | null;
	doneAt: number | null;
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

async function computeAgentVsHuman(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	issues: FlowIssueRow[]
): Promise<{ agent: Distribution; human: Distribution }> {
	const doneIssues = issues.filter((i) => i.claimedAt !== null && i.doneAt !== null);
	if (doneIssues.length === 0) return { agent: summarize([]), human: summarize([]) };

	const issueIds = doneIssues.map((i) => i.id);
	const leaseRows = await orm
		.select({
			issueId: schema.issueLeases.issueId,
			kind: schema.agentSessions.kind,
		})
		.from(schema.issueLeases)
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.where(eq(schema.issueLeases.workspaceId, ctx.workspaceId));

	const agentIssueIds = new Set(
		leaseRows
			.filter((r) => r.kind === "agent" && issueIds.includes(r.issueId))
			.map((r) => r.issueId)
	);

	const agentDurations: number[] = [];
	const humanDurations: number[] = [];
	for (const i of doneIssues) {
		// biome-ignore lint/style/noNonNullAssertion: filtered to claimedAt/doneAt !== null above
		const cycleTime = i.doneAt! - i.claimedAt!;
		(agentIssueIds.has(i.id) ? agentDurations : humanDurations).push(cycleTime);
	}

	return { agent: summarize(agentDurations), human: summarize(humanDurations) };
}

export async function getFlowMetrics(ctx: ServiceCtx, raw: unknown) {
	const result = GetFlowMetricsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { projectId, since, until } = result.data;

	await assertProjectExists(ctx, projectId);

	const orm = drizzle(ctx.db, { schema });

	// Scope by project only, not created_at: since/until describe an activity window
	// (claimed/done), and an issue created before the window but active inside it must
	// still count (e.g. WIP). Row count stays bounded by project size.
	const issues = await orm
		.select({
			id: schema.issues.id,
			readyAt: schema.issues.readyAt,
			claimedAt: schema.issues.claimedAt,
			doneAt: schema.issues.doneAt,
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

	const now = Math.floor(Date.now() / 1000);
	const wipSince = since ?? now - 30 * 86400;
	const wipUntil = until ?? now;
	const wipOverTime = buildWipOverTime(issues, wipSince, wipUntil);

	const cycleWindowIssues = issues.filter((i) => i.doneAt === null || inWindow(i.doneAt));
	const agentVsHuman = await computeAgentVsHuman(ctx, orm, cycleWindowIssues);

	return {
		leadTime: summarize(leadTimes),
		cycleTime: summarize(cycleTimes),
		wipOverTime,
		agentVsHuman,
	};
}
