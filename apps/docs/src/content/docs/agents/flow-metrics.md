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
| `reviewLatency` | in_review → done — the primary human choke point, with a `reviewLatencyOverTime` trend |
| `agingWip` | every currently open (in_progress/in_review) issue with its age since claim — a present-state snapshot, not scoped to `since`/`until`. Read it against `cycleTime`'s p50/p90 as reference lines: it surfaces stuck items before they finish and skew the percentiles. |

## Collaboration shape

| Metric | Definition |
|---|---|
| `humanInterventions` | human-authored comments plus status bounces out of review, per completed issue |
| `autonomyRatio` | lease-held time ÷ **cycle time** (claimed → done), per completed issue |
| `flowEfficiency` | lease-held time ÷ **lead time** (ready → done), for issues completed in the window |

`autonomyRatio` and `flowEfficiency` look similar but divide by different spans:
`autonomyRatio` excludes queueing time before an issue was claimed; `flowEfficiency`
includes it. A project with a long ready→claimed queue will show a lower
`flowEfficiency` than `autonomyRatio` even with identical execution.

## Volume over time

| Metric | Definition |
|---|---|
| `throughput` | issues completed per bucket |
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
| `abandonedClaims` | file claims released because the agent's session ended rather than being released deliberately |
| `gateRejections` | in_review → in_progress bounces specifically — narrower than `humanInterventions`' bounce count, which also counts review → cancelled |
| `wipCapPressure` | claims denied for hitting the project's per-agent WIP cap |

## Using this to tune WIP limits

There's no universally correct WIP limit — [the research says so too](/projektor/philosophy/design-principles/#what-the-flow-literature-says).
Measure your own flow with the metrics above before changing the default cap (see
[Workflow spec](/projektor/agents/workflow-spec/#wip-limits)).
