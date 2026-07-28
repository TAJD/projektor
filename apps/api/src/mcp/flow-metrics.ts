import type { MCPTool } from "@projektor/types";
import { getFlowMetrics } from "../services/flow-metrics";

export const flowMetricsTools: MCPTool[] = [
	{
		name: "get_flow_metrics",
		description:
			"Time-in-state (leadTime, cycleTime, timeInProgress, reviewLatency, agingWip), " +
			"collaboration-shape (humanInterventions, autonomyRatio, flowEfficiency — human " +
			"attention, not an agent-vs-human split), volume-over-time (wipOverTime, throughputOverTime, cfdOverTime, " +
			"arrivalVsCompletionOverTime, bugShareOverTime, bugTypeTracked), and factoryHealth " +
			"(leaseExpiries, abandonedClaims, gateRejections, wipCapPressure) metrics for a project, " +
			"computed from indexed transition timestamps. Full definitions: " +
			"/projektor/agents/flow-metrics/. Two easily-confused pairs: autonomyRatio divides by " +
			"cycleTime (claimed→done) while flowEfficiency divides by leadTime (ready→done), so " +
			"flowEfficiency is always ≤ autonomyRatio when there's a ready→claimed queue; and " +
			"bugTypeTracked:false (no 'bug' task type in the workspace) is distinct from a genuine " +
			"0% bug share. Bucketing defaults to weekly (current ISO week plus the preceding 5 " +
			"weeks); pass granularity: 'day' for daily buckets.",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: {
				projectId: { type: "string", description: "Project UUID" },
				since: {
					type: "number",
					description: "Only issues completed/active at/after this epoch-seconds time",
				},
				until: {
					type: "number",
					description: "Only issues completed/active at/before this epoch-seconds time",
				},
				granularity: {
					type: "string",
					enum: ["day", "week"],
					description: "Throughput bucket granularity, 'day' or 'week' (default 'week')",
				},
			},
		},
		handler(input, ctx) {
			return getFlowMetrics(ctx, input);
		},
	},
];
