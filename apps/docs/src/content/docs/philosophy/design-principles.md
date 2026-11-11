---
title: "Design principles"
description: "The research behind Projektor's workflow design: flow literature, agent engineering, and the six principles where they converge."
sidebar:
  order: 2
---
Projektor's design draws on two literatures: a decades-old one on how *humans* move
work through a tracker, and a few-years-old one on how *agents* fail. Strikingly, they
often reach the same conclusion from opposite directions, and those conclusions are the
principles below.

## What this deliberately isn't

Projektor defers the fashionable automations — triage bots, grooming bots,
status-rollup agents — until the measurement and gating described below exist. The
literature suggests them as low-risk starting points; the same literature says
you can't evaluate them without flow metrics. Measure first.

## What the flow literature says

The strongest empirical work on project management is lean/flow research, not
tool-vendor guidance:

- **Small batches win.** The [DORA research program](https://dora.dev/research/), and the
  book *Accelerate* (Forsgren, Humble, Kim) that reports it, links small batch sizes, short lead times, and
  frequent integration to organisational performance — the most rigorous
  evidence in the field.
- **There is no magic WIP number.** An [empirical study of WIP in kanban teams](https://dl.acm.org/doi/10.1145/3239235.3239238)
  found lower work-in-progress correlates with shorter lead time, but no
  published evidence supports a universal optimal limit. The honest advice:
  [measure your own flow first, then set limits](https://www.atlassian.com/agile/kanban/wip-limits).
- **Pull beats push.** Practitioner consensus on top of the research: explicit
  workflow states with entry/exit criteria, a single prioritised backlog, and
  workers pulling the next item instead of having it pushed onto them.

## What the agent-engineering literature says

- **Boundaries, not vibes.** Anthropic's engineering posts —
  [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
  [the multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
  [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) —
  converge on giving each agent explicit objectives, output formats, and task
  boundaries. Their early orchestrators spawned fifty subagents for simple
  queries; the fix was structural, not exhortative.
- **The ticket is the dispatch unit.** The standard coding-agent benchmark,
  [SWE-bench](https://arxiv.org/abs/2310.06770), is built from real GitHub issues:
  the issue text is the whole task spec, and tests verify the result. Anthropic
  reports agents [solving such issues from the description alone](https://www.anthropic.com/engineering/building-effective-agents).
  A tracker whose tickets carry the spec, the audit trail and the coordination state
  is the natural dispatch surface.
- **Checkpoints are architecture.** The same post recommends that agents "pause for
  human feedback at checkpoints", with stopping conditions and guardrails. Projektor's
  reading: the gates belong at defined workflow stages, enforced by the tool rather
  than left to the operator's memory.

## The six principles

Where the two literatures agree, Projektor treats the conclusion as a design
constraint.

### 1. Tickets are self-contained specs

Humans tolerate tribal context; agents don't. DORA's small-batch finding and
Anthropic's task-boundary finding are the same requirement seen from two
directions: work items must be small, unambiguous, and independently
verifiable. A ticket ready for an agent states its acceptance criteria, names
its files and scope, and includes a verification command.

### 2. WIP limits are enforced by the tool

For humans, WIP discipline is culture. For agents it must be mechanism,
because agents make WIP inflation free — spawning ten workers costs one
prompt. The fifty-subagent failure mode is what unenforced WIP looks like at
agent speed. Concurrency caps belong in the tracker's claim path, not in the
operator's restraint.

### 3. The tracker is the coordination substrate

Agent sessions, file claims, issue leases, heartbeats, channel messages:
coordination state lives in the same durable store as the work itself, not in
ad-hoc side channels. The issue graph is the shared memory; status changes are
the events. (This is the thesis of
[Agentic workflows](/projektor/agents/agent-workflows/).)

### 4. One canonical workflow spec, looked up — not copied

Workflow rules drift the moment they exist in two places. Their source is one file in
the server (`services/workflow-content.ts`): `get_workflow` serves it, so a deployment and
its rules cannot diverge, and the [workflow spec](/projektor/agents/workflow-spec/) page is
generated from it. That's the aim for every consumer; some docs still restate a rule or a
number by hand, and PROJ-907 tracks replacing those with links.

### 5. Measure flow before tuning it

The WIP research is blunt: nobody can tell you your optimal limit. So the
tracker stamps transition timestamps and exposes lead time, cycle time, and
WIP-over-time — the measurements a team needs before tuning defaults like the
agent [concurrency cap](/projektor/philosophy/coordination-model/#wip-limit-as-admission-control) against its own baseline,
not folklore.

### 6. Evidence is checked, not just collected

Agents pull work autonomously, and close it autonomously too: there's no
pre-close block waiting on a human. What replaces the gate is
a check on the way out. Every issue an agent has worked must carry a completion
report (what changed, how it was verified) before it closes, and that verification
text is classified: a resolvable link — a PR, a CI run, a commit — passes silently;
plain prose like "manually tested" gets flagged `needsAudit: true` for a
human to pull later. The discipline isn't blocking the transition; it's
making sure a transition without evidence doesn't disappear into the
timeline unmarked.

## Further reading

For how these principles play out in practice — the multi-agent loop,
coordination primitives, and the tool catalog — see
[Agentic workflows](/projektor/agents/agent-workflows/). For the coordination layer
itself examined as a designed distributed system — identity, leases, file claims,
stale reclaim, conflict routing — see
[Coordination model](/projektor/philosophy/coordination-model/).
