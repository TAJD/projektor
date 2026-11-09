---
title: "Flow metrics reference"
description: "Every metric get_flow_metrics returns, what it measures, and how to read it."
sidebar:
  order: 5
---
`get_flow_metrics` computes these from indexed transition timestamps for one project.
Pass `since`/`until` (epoch seconds) to window it, and `granularity: "day"` for daily
buckets (default is weekly: the current ISO week plus the preceding five).

The collaboration-shape metrics below measure **human attention, not an
agent-vs-human split** — the question they answer is "where does a human's time go,"
not "who did the work."

## Time-in-state

| Metric | Definition |
|---|---|
| `leadTime` | ready → done |
| `cycleTime` | claimed → done |
| `timeInProgress` | claimed → next stage |
| `reviewLatency` | first entry into review → done — the primary human choke point, with a `reviewLatencyOverTime` trend. It measures from the *first* review entry, so an issue sent back for rework includes the rework and every later review wait. |
| `agingWip` | currently open (in_progress/in_review) issues with their age since claim — a present-state snapshot. Over MCP it lists the 10 oldest as `{ref,title,status,ageDays}` plus `agingWipTotal` (`agingWipLimit` up to 50, or `verbose:true` for all); REST returns every item. It is not scoped to `since`/`until`. Read it against `cycleTime`'s p50/p90 as reference lines: it surfaces stuck items before they finish and skew the percentiles. |

**When is an issue "ready"?** When it leaves backlog for an open status (todo, or
straight into in_progress), or is created in one. An issue that goes from backlog
straight to done or cancelled in one update was never ready: it has no lead time,
and `leadTimeExcluded` counts how many such issues finished in the window
(`leadTime.count` is the sample the lead-time percentiles are computed from).

**What counts as review?** A status is a review step only when it is flagged
`isReviewStep` (`create_task_status` / `update_task_status`); the built-in
`in_review` is flagged by default. Entering one requires a completion report when an
agent holds the lease, stamps `in_review_at`, and leaving it for in_progress counts
toward `humanInterventions` and `gateRejections`. A status merely
*named* like a review (e.g. "Contract Review") is not one unless flagged.

## Collaboration shape

| Metric | Definition |
|---|---|
| `humanInterventions` | review decisions per completed issue: each time it was sent back out of review (`review_bounce_count`), plus one for the sign-off if it went through review at all. Issues that never entered review score 0. |
| `autonomyRatio` | lease-held time ÷ **cycle time** (claimed → done), per completed issue that held an agent lease |
| `flowEfficiency` | lease-held time ÷ **lead time** (ready → done), per completed issue that held an agent lease |

**What "human" means here.** Review is a human-owned gate, so every decision on it
counts as human attention whoever made the call and however they connected. A
review approved over MCP with a personal token counts the same as one approved in
the browser. Comments are not counted: the credential that wrote one doesn't say
whether a person was behind it. Before PROJ-1076 this metric counted comments
written through a browser session plus bounces, so it read near zero for anyone
working through an MCP client.

**Lease coverage.** Issues moved to in_progress without an agent lease (by hand, or
`update_issue` with no `claim_issue`) are left out of `autonomyRatio` and
`flowEfficiency`, so a 0 means a lease covered none of the time, not that the issue
was never leased. Compare `autonomyRatio.count` with `cycleTime.count` to see what
share of completed work was leased.

`autonomyRatio` and `flowEfficiency` look similar but divide by different spans:
`autonomyRatio` excludes queueing time before an issue was claimed; `flowEfficiency`
includes it. A project with a long ready→claimed queue will show a lower
`flowEfficiency` than `autonomyRatio` even with identical execution.

## Volume over time

| Metric | Definition |
|---|---|
| `wipOverTime` | work-in-progress (claimed but not done) count per bucket |
| `throughputOverTime` | issues completed per bucket |
| `cfdOverTime` | cumulative flow diagram: per-bucket counts of issues in each stage (`backlogTodo`, `inProgress`, `inReview`, `done`). `done` is cumulative and never decreases; a widening band between two stages is a choke point. |
| `arrivalVsCompletionOverTime` | issues created vs. completed per bucket, plus `net` (created − completed) — answers whether the backlog is growing or burning |
| `bugShareOverTime` | bug share of completed throughput per bucket (`total`, `bugCount`, `bugSharePercent`). Untyped issues count toward `total` but never `bugCount`. A rising trend signals more defects shipping, not just more work. |
| `bugTypeTracked` | whether a task type keyed `bug` exists in the workspace at all. `false` means bug share can't be computed (no matching type) — distinct from a genuine 0%. |

## Factory health

Fault signals for the coordination layer itself, not the work, windowed by
`since`/`until`:

| Metric | Definition |
|---|---|
| `leaseExpiries` | issue leases reclaimed because the holder stopped heartbeating |
| `abandonedClaims` | agent sessions that went silent while holding file claims, counted once per session: their claims were reclaimed by another agent (`expired`), or are still held by the stale session. A deliberate `finish_work`/`end_agent` is not abandonment. Before PROJ-1075 it counted every claim released by any session end, so figures from earlier releases are inflated. |
| `gateRejections` | in_review → in_progress bounces specifically — narrower than `humanInterventions`' bounce count, which also counts review → cancelled |
| `wipCapPressure` | claims denied for hitting the project's per-agent WIP cap |

## Using this to tune WIP limits

There's no universally correct WIP limit — [the research says so too](/projektor/philosophy/design-principles/#what-the-flow-literature-says).
Measure your own flow with the metrics above before changing the default cap (see
[Workflow spec](/projektor/agents/workflow-spec/#wip-limits)).
