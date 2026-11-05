import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import { getFlowMetrics } from "../services/flow-metrics";
import { getIssuesBatch } from "../services/issues";
import { READ } from "./annotations";

const DEFAULT_AGING_WIP = 10;
// getIssuesBatch resolves at most 50 issues per call.
const MAX_AGING_WIP = 50;

type AgingItem = { id: string; status: string; ageSeconds: number };

export const flowMetricsTools: MCPTool[] = [
	{
		name: "get_flow_metrics",
		description:
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
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: {
				projectId: { type: "string", minLength: 1, description: "Project UUID" },
				since: {
					type: "integer",
					minimum: 0,
					description: "Only issues completed/active at/after this epoch-seconds time",
				},
				until: {
					type: "integer",
					minimum: 0,
					description: "Only issues completed/active at/before this epoch-seconds time",
				},
				granularity: {
					type: "string",
					enum: ["day", "week"],
					description: "Throughput bucket granularity, 'day' or 'week' (default 'week')",
				},
				agingWipLimit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_AGING_WIP,
					default: DEFAULT_AGING_WIP,
					description: `How many of the oldest open items agingWip lists (1-${MAX_AGING_WIP})`,
				},
				verbose: {
					type: "boolean",
					description: "Return the raw response (agingWip as every open item's id and ageSeconds)",
				},
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { agingWipLimit, verbose, ...rest } = (input ?? {}) as Record<string, unknown>;
			const metrics = (await getFlowMetrics(ctx, rest)) as { agingWip: AgingItem[] } & Record<
				string,
				unknown
			>;
			if (verbose === true) return metrics;
			// PROJ-1054: the dashboard (REST) plots every open item; an agent needs the few
			// oldest, addressable by ref. The raw list was one UUID row per open issue.
			const limit = agingWipLimit ?? DEFAULT_AGING_WIP;
			if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_AGING_WIP) {
				throw new ValidationError({
					formErrors: [],
					fieldErrors: { agingWipLimit: [`must be an integer from 1 to ${MAX_AGING_WIP}`] },
				});
			}
			const oldest = [...metrics.agingWip]
				.sort((a, b) => b.ageSeconds - a.ageSeconds)
				.slice(0, limit as number);
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
						row && typeof row.project_key === "string"
							? `${row.project_key}-${row.number}`
							: undefined;
					return {
						...(ref ? { ref } : { id: a.id }),
						...(row ? { title: row.title } : {}),
						status: a.status,
						ageDays: Math.round((a.ageSeconds / 86_400) * 10) / 10,
					};
				}),
				agingWipTotal: metrics.agingWip.length,
			};
		},
	},
];
