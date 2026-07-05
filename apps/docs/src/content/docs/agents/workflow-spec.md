---
title: "Workflow spec"
description: "The canonical agent workflow rules: definition of ready, state machine, human gates, WIP limits."
sidebar:
  order: 4
---
This page is the **single home** for projektor's agentic workflow rules. Every other
surface — the MCP server's `initialize` instructions, `AGENTS.md`, spawn prompts, skills —
points here instead of restating these rules. If you're reading a copy of this text
somewhere else, that copy is stale; this page wins. Fetch it programmatically any time
via the `get_workflow` MCP tool or `GET /api/workflow`.

## Definition of ready

An issue is **ready** for an agent to pick up when its body states all three of:

1. **Acceptance criteria** — a checklist or bullet list of concrete, checkable outcomes.
2. **Scope** — the files or components expected to change, named explicitly (not "the
   backend").
3. **Verification** — the exact command(s) that prove the work is done (a test file, a
   lint/type-check command, a fixture run).

`get_prioritized_issues` filters out issues that don't meet this bar by default. Pass
`includeNotReady: true` to see them anyway, tagged with `needsGrooming: true` and the
specific criteria missing — useful for a human doing backlog grooming, not for an agent
picking up autonomous work.

## State machine

| State | Meaning |
|---|---|
| **Backlog** | Not yet triaged into a workable slice. |
| **Ready** | Triaged (`status: todo`) and passes the definition of ready above. |
| **Claimed** | An agent (or human) holds a live lease via `claim_issue`; work is in progress. |
| **In Review** | Work is done from the implementer's side; a structured completion report is attached. |
| **Done** | Reviewed and accepted. |
| **Cancelled** | Won't do. |

## Human gates

- **Ready → Claimed**: may be fully autonomous. Any live agent session can call
  `claim_issue` without a human in the loop, subject to the WIP limit below.
- **In Review → Done**: **always requires a human.** An agent session can never move
  its own (or any) issue to `done` — attempting it is rejected outright, regardless of
  whether a completion report is attached. A human reviews the report and the diff,
  then makes the transition themselves (browser, or a human-kind session).

## Completion reports

Before an agent-held issue can move into `In Review`, it must submit a completion
report with:

- **`summary`** — what changed, in plain language.
- **`verification`** — the command(s) run and their outcome (the same ones named in
  the issue's Verification criteria).
- **`prLink`** *(optional)* — link to the pull request, if one exists.

`summary` and `verification` are required; the transition is rejected with the specific
missing field(s) named if either is absent. The report is recorded as a normal issue
comment, so it's visible in the same timeline as everything else.

## WIP limits

Per DORA and the ESEM work-in-progress research, there's no single "correct" WIP
limit — the right number depends on your own measured flow. Projektor enforces a
**per-project cap on concurrently agent-leased issues** (`claim_issue` rejects once the
cap is reached, naming the current cap and what's already held). The default is **3**,
configurable per project; treat it as a starting point to tune once `get_flow_metrics`
has a few weeks of real data, not a fixed rule.

## Flow metrics

`get_flow_metrics` reports lead time (ready → done), cycle time (claimed → done),
WIP-over-time, and agent-vs-human cycle time for a project, computed from indexed
timestamps stamped the first time an issue enters each state. Use it to decide whether
the WIP limit above is too tight, too loose, or about right — measure before you tune.
