import type { MCPTool } from "@projektor/types";
import { getFlowMetrics } from "../services/flow-metrics";

export const flowMetricsTools: MCPTool[] = [
	{
		name: "get_flow_metrics",
		description:
			"Lead time (ready→done), cycle time (claimed→done), WIP over time, and agent-vs-human cycle " +
			"time for a project, computed from indexed transition timestamps. Measure flow before tuning WIP limits.",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: {
				projectId: { type: "string", description: "Project UUID" },
				since: {
					type: "number",
					description: "Only issues created at/after this epoch-seconds time",
				},
				until: {
					type: "number",
					description: "Only issues created at/before this epoch-seconds time",
				},
			},
		},
		handler(input, ctx) {
			return getFlowMetrics(ctx, input);
		},
	},
];
