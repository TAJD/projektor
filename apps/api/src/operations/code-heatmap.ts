import { GetCodeHeatmapSchema } from "../schemas/code-heatmap";
import { getCodeHeatmap } from "../services/code-heatmap";
import { defineOperation } from "./define";

export const codeHeatmapOperations = [
	defineOperation({
		id: "get_code_heatmap",
		method: "GET",
		path: "/api/projects/:projectId/code-heatmap",
		domain: "code-heatmap",
		tier: "read",
		keywords: ["files", "hotspots", "claims", "contention", "codebase", "directories"],
		summary:
			"Where work lands in the codebase, from file-claim history — no git " +
			"integration needed. Aggregates claims one path segment below `prefix` (omit for the " +
			"top level), sized by distinctIssueCount (distinct issues that claimed a path under that " +
			"segment, claimedAt within [since, until]) plus claimCount (raw claim count, including " +
			"released ones). Each entry's `path` is the drill-down cursor: re-call with `prefix` set " +
			"to it to see what's under a directory; `isLeaf` marks an entry that is itself a claimed " +
			"file path, not a directory. Defaults to the current ISO week plus the preceding 5 weeks, " +
			"matching get_flow_metrics. `mode` switches sizing between claim volume and claim " +
			"contention (claim_conflicts).",
		input: GetCodeHeatmapSchema,
		run: (ctx, input) => getCodeHeatmap(ctx, input),
	}),
];
