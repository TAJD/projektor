import { z } from "zod";
import { GetFlowMetricsSchema } from "../schemas/flow-metrics";
import { getFlowMetrics } from "../services/flow-metrics";
import { getIssuesBatch } from "../services/issues";
import type { ServiceCtx } from "../services/types";
import { defineOperation } from "./define";

const DEFAULT_AGING_WIP = 10;
const MAX_AGING_WIP = 50;

type AgingItem = { id: string; status: string; ageSeconds: number };

const FlowMetricsInput = GetFlowMetricsSchema.safeExtend({
	agingWipLimit: z
		.number()
		.int()
		.min(1)
		.max(MAX_AGING_WIP)
		.default(DEFAULT_AGING_WIP)
		.meta({ description: `How many of the oldest open items agingWip lists (1-${MAX_AGING_WIP})` }),
	verbose: z.boolean().optional().meta({
		description: "Return the raw response (agingWip as every open item's id and ageSeconds)",
	}),
});

async function oldestAgingWip(
	ctx: ServiceCtx,
	metrics: { agingWip: AgingItem[] } & Record<string, unknown>,
	limit: number
) {
	const oldest = [...metrics.agingWip].sort((a, b) => b.ageSeconds - a.ageSeconds).slice(0, limit);
	const rows = new Map<string, Record<string, unknown>>();
	if (oldest.length > 0) {
		const batch = (await getIssuesBatch(ctx, { ids: oldest.map((a) => a.id) })) as {
			items: Record<string, unknown>[];
		};
		for (const row of batch.items) rows.set(row.id as string, row);
	}
	return {
		...metrics,
		agingWip: oldest.map((a) => {
			const row = rows.get(a.id);
			const ref =
				row && typeof row.project_key === "string" ? `${row.project_key}-${row.number}` : undefined;
			return {
				...(ref ? { ref } : { id: a.id }),
				...(row ? { title: row.title } : {}),
				status: a.status,
				ageDays: Math.round((a.ageSeconds / 86_400) * 10) / 10,
			};
		}),
		agingWipTotal: metrics.agingWip.length,
	};
}

export const flowMetricsOperations = [
	defineOperation({
		id: "get_flow_metrics",
		method: "GET",
		path: "/api/projects/:projectId/flow-metrics",
		domain: "flow-metrics",
		tier: "read",
		keywords: ["cycle time", "lead time", "throughput", "wip", "cfd", "dora", "velocity", "aging"],
		summary:
			"Time-in-state (leadTime, cycleTime, timeInProgress, reviewLatency, agingWip), " +
			"collaboration-shape (humanInterventions, autonomyRatio, flowEfficiency — human " +
			"attention, not an agent-vs-human split), volume-over-time (wipOverTime, throughputOverTime, cfdOverTime, " +
			"arrivalVsCompletionOverTime, bugShareOverTime, bugTypeTracked), and factoryHealth " +
			"(leaseExpiries, abandonedClaims, gateRejections, wipCapPressure) metrics for a project. " +
			"Full definitions: /projektor/agents/flow-metrics/. Two easily-confused pairs: autonomyRatio divides by " +
			"cycleTime (claimed→done) while flowEfficiency divides by leadTime (ready→done), so " +
			"flowEfficiency is always ≤ autonomyRatio when there's a ready→claimed queue; and " +
			"bugTypeTracked:false (no 'bug' task type in the workspace) is distinct from a genuine " +
			"0% bug share. Bucketing defaults to weekly (current ISO week plus the preceding 5 " +
			"weeks); pass granularity: 'day' for daily buckets. agingWip lists only the oldest " +
			`${DEFAULT_AGING_WIP} open items as {ref,title,status,ageDays} (agingWipLimit for more, ` +
			"agingWipTotal for the count); verbose:true returns the raw response.",
		input: FlowMetricsInput,
		run: (ctx, { projectId, since, until, granularity }) =>
			getFlowMetrics(ctx, { projectId, since, until, granularity }),
		mcpResult: (result, { agingWipLimit, verbose }, ctx) =>
			verbose
				? result
				: oldestAgingWip(
						ctx,
						result as { agingWip: AgingItem[] } & Record<string, unknown>,
						agingWipLimit
					),
	}),
];
