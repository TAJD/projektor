// PROJ-335: the single source of truth for every stat/chart's help text on the metrics
// dashboard. `Record<MetricId, MetricDefinition>` is exhaustive — adding a MetricId to the
// union without adding a matching entry here (or vice versa) is a compile error, so a new
// stat can't ship without a definition.

export type MetricId =
	| "lead-time"
	| "cycle-time"
	| "wip"
	| "throughput"
	| "bug-share"
	| "review-latency"
	| "human-interventions"
	| "autonomy-ratio"
	| "cumulative-flow"
	| "time-in-progress"
	| "arrival-vs-completion"
	| "flow-efficiency"
	| "aging-wip"
	| "lease-expiries"
	| "abandoned-claims"
	| "gate-rejections"
	| "wip-cap-pressure"
	| "code-heatmap"
	| "code-heatmap-contention";

export interface MetricDefinition {
	label: string;
	/** One sentence: what the stat means. */
	definition: string;
	/** One sentence: how it's computed. */
	computation: string;
}

export const METRIC_DEFINITIONS: Record<MetricId, MetricDefinition> = {
	"lead-time": {
		label: "Lead time",
		definition: "How long an issue waits from becoming ready to work through to done.",
		computation: "Lead time = done − ready, for issues completed in the window.",
	},
	"cycle-time": {
		label: "Cycle time",
		definition: "How long active work on an issue takes, once someone starts it.",
		computation: "Cycle time = done − claimed, for issues completed in the window.",
	},
	wip: {
		label: "WIP over time",
		definition: "How many issues are actively in progress at once, across the window.",
		computation: "Count of issues in the in_progress status, sampled daily.",
	},
	throughput: {
		label: "Throughput",
		definition: "How many issues the factory finishes per bucket.",
		computation: "Count of issues reaching done per bucket (day or week).",
	},
	"bug-share": {
		label: "Bug share",
		definition: "What fraction of completed work each bucket was bug fixes, not new work.",
		computation:
			"Bug share = bug-typed issues completed ÷ all issues completed, per bucket; buckets with " +
				"no completions are gapped, not zero.",
	},
	"review-latency": {
		label: "Review latency",
		definition: "How long an issue sits in review before a human signs off.",
		computation: "Review latency = done − entered review, for issues completed in the window.",
	},
	"human-interventions": {
		label: "Human interventions",
		definition: "How much direct human attention a completed issue needed.",
		computation:
			"Count of human-authored comments plus status bounces (review → in progress), per completed issue.",
	},
	"autonomy-ratio": {
		label: "Autonomy ratio",
		definition: "What share of a completed issue's cycle time an agent held the work unattended.",
		computation: "Autonomy ratio = lease-held time ÷ total cycle time, per completed issue.",
	},
	"cumulative-flow": {
		label: "Cumulative flow",
		definition:
			"How many issues sit in each status category over time — a widening band shows where work is backing up.",
		computation:
			"Stacked counts of issues in backlog/todo, in progress, in review, and done, sampled per bucket.",
	},
	"time-in-progress": {
		label: "Time in progress",
		definition: "How long an issue spends being actively worked, before review.",
		computation:
			"Time in progress = entered review (or done, if review was skipped) − claimed, for issues completed in the window.",
	},
	"arrival-vs-completion": {
		label: "Arrival vs completion",
		definition: "Whether the backlog is growing or shrinking, bucket by bucket.",
		computation:
			"Net = issues created − issues completed, per bucket; a positive net means the backlog is growing.",
	},
	"flow-efficiency": {
		label: "Flow efficiency",
		definition:
			"What share of an issue's total time from ready to done was actual agent work, versus waiting.",
		computation:
			"Flow efficiency = lease-held time ÷ lead time (ready → done), for issues completed in the window.",
	},
	"aging-wip": {
		label: "Aging WIP",
		definition:
			"How long issues that are still open have already been in progress or review — stuck " +
				"work shows up here before it finishes.",
		computation:
			"Age since claim for every currently open in_progress/in_review issue, plotted against " +
				"this window's cycle-time p50/p90.",
	},
	"lease-expiries": {
		label: "Lease expiries",
		definition: "How often an agent died mid-work and its claim on an issue had to be reclaimed.",
		computation:
			"Count of issue leases reclaimed because the holding agent stopped heartbeating, in the window.",
	},
	"abandoned-claims": {
		label: "Abandoned claims",
		definition:
			"How often a file claim was released because an agent's session ended, not deliberately.",
		computation:
			"Count of file claims released by session end (not explicit release), in the window.",
	},
	"gate-rejections": {
		label: "Gate rejections",
		definition: "How often review sent work back for rework instead of approving it.",
		computation: "Count of issues moved from in review back to in progress, in the window.",
	},
	"wip-cap-pressure": {
		label: "WIP-cap pressure",
		definition:
			"How often a claim was denied because the project's agent WIP cap was already full.",
		computation:
			"Count of claim_issue calls rejected for exceeding the project's agent WIP limit, in the window.",
	},
	"code-heatmap": {
		label: "Where work lands",
		definition: "Which parts of the codebase are seeing the most work, by file claims.",
		computation:
			"Directories/paths sized by distinct issues that claimed files there, from file-claim history in the window.",
	},
	"code-heatmap-contention": {
		label: "Where the fleet queues up",
		definition:
			"Which parts of the codebase cause agents to collide over file claims, blocking parallelism.",
		computation:
			"Directories/paths sized by distinct issues whose claim_files attempt was rejected or " +
				"overridden there, in the window.",
	},
};
