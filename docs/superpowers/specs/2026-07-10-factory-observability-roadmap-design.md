# Factory Observability Roadmap — Design

**Date:** 2026-07-10
**Status:** Approved (discussion in session; a/b/c confirmed)
**Deliverables:** PROJ wiki `roadmap` page + tracker epic with children. No code in this session.

## Vision (two pillars)

Projektor is a project implementation and organisation tool with two pillars:

1. **Work orchestration** — planning and safely executing work with mixed
   human/agent teams: definition of ready, issue leases, file claims, review
   gates, groups/access. Largely built; hardening continues under PROJ-286 and
   PROJ-314.
2. **Factory observability** — per-project visibility into the *system that
   produces the software*: its rate (flow metrics), its health (choke points,
   rework, stale WIP), and where in the codebase work concentrates
   (claims-derived heat map). **Projektor-native data first** — file claims,
   leases, transition timestamps, completion reports. Git/PR and analyzer
   integrations are explicitly "Later".

## Philosophy shift: retire actor attribution

The "agent vs human" split is a false dichotomy: every issue is a human+agent
collaboration (human writes the ticket, agent implements, human reviews and
approves the done transition). The scarce resource worth measuring is **human
attention**, so binary attribution is replaced by **collaboration-shape
metrics** (review latency, interventions per issue, autonomy ratio).

Sweep results — where the dichotomy lives:

- **Remove (metrics attribution):** `computeAgentVsHuman` + `agentVsHuman` API
  field (`apps/api/src/services/flow-metrics.ts`), `AgentVsHumanTiles`
  (`apps/web/src/islands/MetricsDashboard.tsx`) + tests, the `get_flow_metrics`
  MCP tool description (`apps/api/src/mcp/flow-metrics.ts`), and the
  workflow-spec docs text (`apps/docs/.../workflow-spec.md`,
  `apps/docs/.../tool-catalog.md`, and the served copy in
  `apps/api/src/services/workflow-content.ts`).
- **Audit (likely vestigial):** the self-declared `kind: agent|human` enum on
  `register_agent` (`apps/api/src/schemas/agents.ts`,
  `apps/api/src/mcp/agents.ts`). PROJ-287 bound the review/done gate to the
  authenticated principal, so caller-supplied kind may no longer drive anything;
  it was also the original spoof vector.
- **Keep (accountability, not attribution):** the "In Review → Done requires a
  human" gate.

## Epic: Factory observability (projektor-native)

| # | Child ticket | Priority |
|---|--------------|----------|
| 1 | Throughput chart: date-range picker + day/week granularity toggle; default = current ISO week + preceding 5; API gains `granularity`; UI passes `since`/`until` | high |
| 2 | Retire the agent/human split (API field, tiles, MCP/docs text) | high |
| 3 | Collaboration-shape metrics: review latency p50/p90, human interventions per issue, autonomy ratio (lease-held time ÷ cycle time) | medium |
| 4 | Cumulative flow diagram + time-in-state breakdown | high |
| 5 | Arrival vs completion rate, flow efficiency %, aging-WIP scatter | medium |
| 6 | Throughput by task type (bug-share trend as quality proxy) | medium |
| 7 | Codebase heat map: treemap of paths by file-claim frequency (claims are soft-released, history already persisted) | medium |
| 8 | Claim contention / parallelism ceiling — needs design; rejected claim attempts aren't recorded today | low |
| 9 | Factory health tiles: lease expiries, abandoned claims, gate rejections, WIP-cap pressure | medium |
| 10 | Stat help icons: ⓘ popover per stat/chart, one shared definitions map (docs glossary renders the same source) | high |
| 11 | Audit/retire the self-declared `kind` field on register_agent | low |

All ticket bodies are DoR-compliant (acceptance criteria, scope/files,
verification), matching PROJ-286 house style.

## Housekeeping

- **PROJ-308** — close as shipped (metrics page exists); comment that the
  split-exclusion it mandated is enforced via child #2.
- **PROJ-294** — activity-window filtering appears already implemented
  (`flow-metrics.ts` scopes by project, windows on `doneAt`, WIP ignores
  `created_at`); verify and close with a comment.
