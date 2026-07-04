# Design spec: Agentic workflow hardening

Status: draft
Date: 2026-07-04

Projektor's thesis is that the issue tracker is the coordination substrate for AI
agents. This spec grounds that thesis in the research literature and lays out a
phased plan for hardening the agentic workflow: codified workflow rules, flow
measurement, tool-enforced WIP/readiness, and human-gated review.

Explicitly **out of scope for now**: autonomous automation agents (triage bots,
grooming bots, status-rollup bots). The literature recommends them as low-risk
starting points, but they are deferred until the measurement and gating layers
below exist.

## Research grounding

### Flow research (human PM literature)

The strongest empirical work on PM workflows is lean/flow research, not tool-vendor
guidance:

- **Accelerate / DORA** (Forsgren, Humble, Kim): small batch sizes, short lead
  time, trunk-based development with short-lived branches, and deployment
  frequency predict organizational performance.
  ([Accelerate & DORA metrics](https://openpracticelibrary.com/blog/accelerate-metrics-software-delivery-performance-measurement/),
  [DORA metrics guide](https://getdx.com/blog/dora-metrics/))
- **Kanban/WIP**: an [empirical ESEM study of WIP in kanban teams](https://dl.acm.org/doi/10.1145/3239235.3239238)
  found lower WIP correlates with shorter lead time, but there is **no published
  evidence for an optimal WIP limit** — it is context-dependent. The practical
  advice ([Atlassian](https://www.atlassian.com/agile/kanban/wip-limits)) is to
  measure your own flow first, then set limits.
- Practitioner consensus on top: explicit workflow states with entry/exit
  criteria, a single prioritized backlog, pull-based (not push-based) assignment.

### Agentic workflow research

- **Anthropic engineering posts** —
  [Building effective agents](https://resources.anthropic.com/building-effective-ai-agents),
  [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
  [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
  Key lessons: prefer deterministic orchestration over free-form agents; give
  subagents explicit objectives, output formats, and task boundaries; multi-agent
  costs ~15× tokens, so reserve it for high-value work; simple LLM-as-judge
  rubrics (score + pass/fail) evaluate output most reliably.
- **Issue trackers as agent infrastructure**
  ([MindStudio](https://www.mindstudio.ai/blog/issue-trackers-ai-agent-infrastructure-jira-linear)):
  the ticket is the unit of agent dispatch — it carries the spec, the audit
  trail, and the coordination state. API-first trackers win.
- **Governance** ([InfoWorld](https://www.infoworld.com/article/4154570/best-practices-for-building-agentic-systems.html),
  [Virtido](https://virtido.com/blog/agentic-workflows-patterns-best-practices-enterprise)):
  human-in-the-loop checkpoints at defined workflow stages, agent identity /
  registries, and policy enforced at the point of action rather than by
  operator discipline.

### Synthesis — where the two literatures agree

1. **Tickets must be self-contained specs.** Humans tolerate tribal context;
   agents don't. DORA's "small batch" finding and Anthropic's "clear task
   boundaries" finding are the same requirement from two directions: small,
   unambiguous, independently verifiable work items.
2. **WIP limits matter more for agents.** Agents make WIP effectively free to
   inflate (spawn ten workers) — exactly the failure mode Anthropic observed
   (50 subagents for a simple query). The tracker should enforce concurrency,
   not rely on the operator's discipline.
3. **The tracker is the coordination substrate.** Leases, file claims, agent
   registry, heartbeats — projektor already has these primitives. The next
   layers are workflow-stage gating (which transitions require a human) and
   flow measurement.

## Principle: one canonical workflow spec, looked up — not copied

Workflow rules must have exactly one home: the docs site
(`apps/docs/src/content/docs/agents/`). Every consumer — the MCP server's
`initialize` instructions, spawn prompts, the fleet skill, AGENTS.md — points
at it rather than restating it.

Today the rules are duplicated: AGENTS.md holds the fleet coordination
protocol, and `routes/mcp.ts` hardcodes a `SERVER_INSTRUCTIONS` copy with a
"keep in sync with AGENTS.md" comment. That is the drift failure mode this
principle removes.

Mechanism:

- **Canonical text** lives as a docs-site page (versioned, deployed with each
  release, human-readable at a stable URL).
- **The MCP server serves it**, rather than merely linking it: the workflow
  page's markdown is bundled into the Worker at build time and exposed via a
  `get_workflow` MCP tool (and REST equivalent, per the service-layer
  contract). Serving beats linking because the deployed server and its rules
  then version together, and agents without web access still get the spec.
- **`SERVER_INSTRUCTIONS` shrinks to a pointer**: a one-paragraph summary plus
  "call `get_workflow` before claiming work." No rule text in the string.
- **Skills and spawn prompts** likewise instruct agents to fetch the spec at
  session start instead of embedding rules.

## Plan

Each phase pays for itself before the next. Phase 2 (measurement) is the
load-bearing one: it turns WIP defaults and workflow tuning from vibes into
measured decisions.

### Phase 1 — Codify the workflow on the docs site and serve it over MCP

Write the workflow spec as a docs-site page
(`apps/docs/src/content/docs/agents/workflow-spec.md`, alongside the existing
`agent-workflows.md` overview) defining:

- **Definition of ready** for agent-claimable tickets: acceptance criteria
  present, files/scope named, verification command stated.
- **State machine**: Backlog → Ready → Claimed → In Review → Done.
- **Human gates**: Ready→Claimed may be autonomous; In Review→Done requires a
  human.

Then wire up lookup per the canonical-source principle above:

- Bundle the page's markdown into the Worker; expose it via a `get_workflow`
  MCP tool + REST endpoint (shared service).
- Replace the rule text in `SERVER_INSTRUCTIONS` (`routes/mcp.ts`) with a
  pointer to `get_workflow`; slim the AGENTS.md fleet-protocol section to a
  pointer likewise.

Verify: a spawned agent with only the MCP connection can restate the rules
(via `get_workflow`); grep confirms no second copy of the rule text remains in
`routes/mcp.ts` or AGENTS.md.

### Phase 2 — Measure flow before tuning it

Stamp indexed transition timestamps on issues (`ready_at`, `claimed_at`,
`done_at`) at transition time — indexed columns, not derive-on-read from the
activity log. Expose flow metrics (lead/cycle time distribution, WIP over time,
agent-vs-human cycle time) via a service + both surfaces (REST and MCP, per the
service-layer contract).

Verify: metrics computed correctly against a seeded fixture project in tests.

### Phase 3 — Enforce WIP and readiness in the tool

- `get_prioritized_issues` filters out (or flags "needs grooming") tickets
  failing the definition of ready.
- Per-project agent WIP limit: `claim_issue` rejects when N issues are already
  agent-leased. Configurable; default derived from the Phase 2 baseline.

Verify: API tests for both rejections; a fleet run respects the cap.

### Phase 4 — Close the loop with review gating

Agent-completed issues land in "In Review" with a structured completion report
(what changed, verification output, PR link) as a comment. The transition to
Done is rejected for agent sessions unless the report fields are present —
enforced in the service so REST and MCP behave identically. Optional follow-up:
an LLM-judge pass/fail pre-check per Anthropic's rubric finding.

Verify: an agent cannot move its own issue to Done; a full fleet cycle produces
reviewable completion reports end-to-end.

## Deferred

- Autonomous triage/grooming and status-rollup agents (previously "phase 4"):
  revisit once measurement (Phase 2) and gating (Phase 4) are in place and can
  show whether they help.
