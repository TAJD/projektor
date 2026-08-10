---
title: "Design principles"
description: "The research behind Projektor's workflow design: flow literature, agent engineering, and the six principles where they converge."
sidebar:
  order: 2
---
Projektor combines AI-native design with tried-and-tested principles. This
page presents the evidence: the two bodies of research the design draws on, and
the principles that fall out where they agree.

Two literatures matter. One is decades old and studies how *humans* move work
through a tracker. The other is a few years old and studies how *agents* fail.
Strikingly, they often reach the same conclusion from opposite directions.

## What the flow literature says

The strongest empirical work on project management is lean/flow research, not
tool-vendor guidance:

- **Small batches win.** The [Accelerate/DORA research](https://openpracticelibrary.com/blog/accelerate-metrics-software-delivery-performance-measurement/)
  (Forsgren, Humble, Kim) links small batch sizes, short lead times, and
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
  [Building effective agents](https://resources.anthropic.com/building-effective-ai-agents),
  [the multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
  [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) —
  converge on giving each agent explicit objectives, output formats, and task
  boundaries. Their early orchestrators spawned fifty subagents for simple
  queries; the fix was structural, not exhortative.
- **The ticket is the dispatch unit.** The emerging
  [trackers-as-agent-infrastructure argument](https://www.mindstudio.ai/blog/issue-trackers-ai-agent-infrastructure-jira-linear):
  API-first trackers win because the ticket carries the spec, the audit trail,
  and the coordination state.
- **Checkpoints are architecture.** Governance work
  ([InfoWorld](https://www.infoworld.com/article/4154570/best-practices-for-building-agentic-systems.html),
  [enterprise patterns](https://virtido.com/blog/agentic-workflows-patterns-best-practices-enterprise))
  puts human-in-the-loop gates at defined workflow stages and enforces policy
  at the point of action — not in the operator's memory.

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

Workflow rules drift the moment they exist in two places. The rules get
exactly one home — this documentation site — and every consumer (the MCP
server's instructions, contributor docs, skills, spawn prompts) points at it
rather than restating it. The server *serves* the spec so the deployed version
and its rules cannot diverge.

### 5. Measure flow before tuning it

The WIP research is blunt: nobody can tell you your optimal limit. So the
tracker stamps transition timestamps and exposes lead time, cycle time, and
WIP-over-time — the measurements a team needs before tuning defaults like the
agent concurrency cap (currently a flat default of 3) against its own baseline,
not folklore.

### 6. Evidence is checked, not just collected

Agents pull work autonomously, and close it autonomously too: there's no
pre-close block waiting on a human. What replaces the gate is
a check on the way out. Every agent-closed issue must carry a completion
report (what changed, how it was verified), and that verification text is
classified: a resolvable link — a PR, a CI run, a commit — passes silently;
plain prose like "manually tested" gets flagged `needsAudit: true` for a
human to pull later. The discipline isn't blocking the transition; it's
making sure a transition without evidence doesn't disappear into the
timeline unmarked.

## What this deliberately isn't

Projektor defers the fashionable automations — triage bots, grooming bots,
status-rollup agents — until the measurement and gating above exist. The
literature suggests them as low-risk starting points; the same literature says
you can't evaluate them without flow metrics. Measure first.

For how these principles play out in practice — the multi-agent loop,
coordination primitives, and the tool catalog — see
[Agentic workflows](/projektor/agents/agent-workflows/).
