import type { MCPTool } from "@projektor/types";
import { getFlowMetrics } from "../services/flow-metrics";

export const flowMetricsTools: MCPTool[] = [
	{
		name: "get_flow_metrics",
		description:
			"Lead time (ready→done), cycle time (claimed→done), WIP over time, throughput over time, and " +
			"collaboration-shape metrics for a project, computed from indexed transition timestamps. " +
			"Collaboration-shape metrics measure human attention rather than agent-vs-human split: " +
			"reviewLatency (in_review→done, the primary human choke point) with a reviewLatencyOverTime " +
			"trend; humanInterventions (human-authored comments + status bounces out of review, per " +
			"completed issue); and autonomyRatio (lease-held time ÷ cycle time, per completed issue). " +
			"cfdOverTime is a cumulative flow diagram: per-bucket counts of issues currently in each " +
			"stage (backlogTodo, inProgress, inReview, done), derived from the same transition " +
			"timestamps — done is cumulative (never decreases) and a widening band is a choke point. " +
			"timeInProgress (claimed→next stage) pairs with reviewLatency as the time-in-state " +
			"breakdown. arrivalVsCompletionOverTime is created vs completed issues per bucket plus " +
			"net (created - completed), answering whether the backlog is growing or burning. " +
			"flowEfficiency is lease-held time / lead time (lead time = done - ready) for issues " +
			"completed in the window, with a flowEfficiencyOverTime trend - distinct from " +
			"autonomyRatio, which divides by cycle time (done - claimed) instead and so excludes " +
			"queueing time between ready and claimed. agingWip lists every currently open " +
			"(in_progress/in_review) issue with its age since claim, a present-state snapshot not " +
			"scoped to since/until, meant to be read against this response's cycleTime p50/p90 as " +
			"reference lines - makes stuck items visible before they finish and skew the percentiles. " +
			"bugShareOverTime is the bug share of completed throughput per bucket (total completed, " +
			"bugCount, bugSharePercent) - untyped issues count toward total but never bugCount; a " +
			"rising trend signals the factory shipping more defects, not just more work. " +
			"Measure flow before tuning WIP limits. Throughput/review-latency/CFD/arrival/bug-share " +
			"bucketing defaults to weekly (current ISO week plus the preceding 5 weeks); pass " +
			"granularity: 'day' for daily buckets.",
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
