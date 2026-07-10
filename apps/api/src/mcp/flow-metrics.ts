import type { MCPTool } from "@projektor/types";
import { getFlowMetrics } from "../services/flow-metrics";

export const flowMetricsTools: MCPTool[] = [
	{
		name: "get_flow_metrics",
		description:
			"Lead time (ready→done), cycle time (claimed→done), WIP over time, and throughput over time " +
			"for a project, computed from indexed transition timestamps. Measure flow before tuning WIP " +
			"limits. Throughput bucketing defaults to weekly (current ISO week plus the preceding 5 " +
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
