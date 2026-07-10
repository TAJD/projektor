# Agentic workflow hardening (PROJ-250)

Status: in progress. This is the design record for the phased plan; the canonical
*operator-facing* spec this plan produces lives at
`apps/docs/src/content/docs/agents/workflow-spec.md` (Phase 1) and is served live via
the `get_workflow` MCP tool / REST endpoint. This file is the *why* and the decisions
made along the way; don't restate rule text here that lives there instead.

## Motivation

The fleet protocol in `AGENTS.md` today is operator discipline: agents are trusted to
register, claim files, heartbeat, and release — nothing enforces it, and nothing
measures whether it's working. Three bodies of evidence say that's the wrong
long-term shape:

- **DORA/Accelerate**: small batches and short lead time correlate with throughput and
  stability. We have no lead-time signal today.
- **ESEM WIP research**: there is no universal "right" WIP limit — teams that measure
  their own flow before capping it outperform teams that copy a number from a book.
  This is why Phase 2 (measure) is sequenced *before* Phase 3 (enforce a cap).
- **Anthropic's agent-engineering write-ups**: the concrete failure mode is a manager
  agent fanning out 50 subagents with no cap and no explicit task boundaries, burning
  budget on rework. The fix pattern is explicit task boundaries (definition of ready),
  enforced concurrency (WIP limit), and a human checkpoint before "done" counts.

Core principle carried through every phase: **workflow rules have exactly one home —
the docs site.** Every consumer (MCP `SERVER_INSTRUCTIONS`, `AGENTS.md`, skills, spawn
prompts) points at it instead of restating it. Duplicated rule text is how the fleet
protocol and the docs page silently drift.

## Conceptual state machine

The DB already has a `status_category` enum (`todo | in_progress | done | cancelled`,
`packages/db/src/schema/issues.ts`) plus the free-text `status` key
(`backlog | todo | in_progress | in_review | done | cancelled`). No new stored status
is introduced. "Ready" and "Claimed" are **derived**, not stored:

| Conceptual state | Derived from |
|---|---|
| Backlog | `status = 'backlog'` |
| Ready | `status_category = 'todo'` (i.e. `todo`) **and** passes definition-of-ready (Phase 3) |
| Claimed | `status_category = 'in_progress'` **and** a live `issue_leases` row exists |
| In Review | `status = 'in_review'` |
| Done / Cancelled | `status_category = 'done'` / `'cancelled'` |

Human gates: `Ready → Claimed` may be autonomous (an agent calls `claim_issue`).
`In Review → Done` requires a human — see Phase 4.

## Phase 1 — Canonical spec + `get_workflow`

Writes the state machine above, the definition of ready (below), and the human gates
as prose on the docs site; serves it through the existing service-layer contract
(`services/workflow.ts` → `routes/workflow.ts` + `mcp/workflow.ts`). `SERVER_INSTRUCTIONS`
in `routes/mcp.ts` shrinks to a pointer ("call `get_workflow` before claiming work");
`AGENTS.md`'s fleet-protocol section keeps the *mechanical* call sequence (it's
operational, repo-specific) but no longer restates the rationale/spec prose that now
lives on the docs page.

**Single-source mechanics:** the spec text itself lives once, as a plain TS constant
(`services/workflow-content.ts`), not as a `?raw` import of the docs markdown file.
Tried the `?raw` import first (mirroring how `packages/db/migrations/*.sql?raw` is
loaded in tests) — it works under Vite (vitest) and would work in the wrangler/esbuild
release bundle, but breaks `apps/api/scripts/gen-mcp-catalog.ts` and the new
`gen-workflow-spec.ts`, both invoked directly via `tsx`, which doesn't apply Vite's
`?raw` loader and chokes on the markdown's frontmatter as if it were JS. A plain TS
export loads identically under all three toolchains (tsx, vitest, wrangler), so the
docs page is instead *generated* from the TS constant by `gen-workflow-spec.ts` — the
same pattern already used for the MCP tool catalog (`gen-mcp-catalog.ts`), with the
same CI staleness gate (`pnpm gen:docs` + `git diff --exit-code`).

## Phase 2 — Flow metrics

### Decision: three new indexed timestamp columns, stamp-once semantics

`ready_at`, `claimed_at`, `done_at` on `issues`, stamped in `updateIssue`'s status-transition
path (same place `completedAt` is already stamped) the *first* time an issue enters the
corresponding state. Unlike `completed_at` (PROJ-212), which is cleared when an issue
leaves `done` so "currently completed" filters stay correct, the three new columns are
**write-once and never cleared** — reopening a `done` issue and redoing it is real
rework and should still show up in a lead-time calculation, not be erased. This is the
"pick one and document it" call the Phase 2 acceptance criteria asks for.

- `ready_at`: first transition into `status_category = 'todo'` (leaving `backlog`).
- `claimed_at`: first transition into `status_category = 'in_progress'`.
- `done_at`: first transition into `status_category = 'done'`.

### Flow metrics service

`services/flow-metrics.ts` computes, per project (optionally filtered by date range):
lead time (`done_at - ready_at`), cycle time (`done_at - claimed_at`), and WIP-over-time
(count of issues with `claimed_at` set and no `done_at`/`cancelled` bucketed by day).
The agent-vs-human split originally computed here was retired (PROJ-327) — it labelled
a whole issue by lease presence, a false dichotomy since every issue is a human+agent
collaboration. Exposed as `get_flow_metrics` (MCP) and `GET /api/projects/:id/flow-metrics` (REST).

## Phase 3 — Definition of ready + WIP limit

### Definition of ready (DoR)

An issue is **ready** when its body contains, as a heuristic text check (no new
structured fields — the epic body already writes this way; forcing a schema change
would break existing issues):

1. An "Acceptance criteria" section (or equivalent heading) that is non-empty.
2. A named scope — either a "Scope" / "Files" section, or at least one inline code
   span (`` `path/to/file` ``) in the body.
3. A stated verification command/step — a "Verification" section, or the word
   "verification"/"test" followed by a command-like token.

`get_prioritized_issues` runs this check per candidate issue and either drops
not-ready issues (default) or, with `includeNotReady: true`, includes them tagged
`needsGrooming: true` with the specific missing criteria — so a human triaging the
backlog can see *why* something isn't ready without the agent picking it up blind.

### WIP limit

Reuses the existing `issue_leases` + `agent_sessions` liveness logic
(`liveLeasedIssueIds`/`services/issue-leases.ts`) — a live lease already means "an
agent is on this." `claim_issue` counts live leases whose issue belongs to the same
project as the candidate; if the count is `>=` the project's cap, it throws
`ConflictError` naming the cap and the currently-held issue refs.

Cap is configurable per project (`projects.agent_wip_limit`, nullable integer;
`NULL` = use the workspace default). Default: **3**. This is a starting point, not a
measured value — Phase 2 ships first but real flow data takes days of usage to
accumulate, and shipping Phase 3 with no cap at all defeats its purpose. 3 mirrors the
scale Anthropic's own postmortems describe as the point subagent fan-out starts
degrading coherence. Revisit once `get_flow_metrics` has a few weeks of data: if WIP-
over-time rarely approaches 3, raise it; if agent cycle time degrades near the cap,
lower it.

## Phase 4 — Review gating

### Identifying "an agent did this"

`agent_sessions.kind` (`'agent' | 'human'`) already distinguishes the two — a human
using the browser never has an `agentSessionId` to pass. Mutations that need the gate
accept an optional `agentSessionId` (same shape as `claim_issue`/`release_issue`); when
present, the service looks up the session's `kind`.

### The gate

1. **Entering `in_review` with an `agentSessionId` whose session `kind = 'agent'`**
   requires a completion report in the same call: `{ summary, verification, prLink? }`
   (`summary`/`verification` required, non-empty). Missing fields throw a
   `ValidationError` naming exactly which are missing. On success the service writes
   the report as a formatted `issue_comments` row (visible in the normal comment
   timeline) and stamps a new indexed `issues.completion_report_at` column.
2. **Transitioning to `done`**: if the call carries an `agentSessionId` whose session
   `kind = 'agent'`, reject with `ForbiddenError` — agents can never self-approve,
   full stop, regardless of whether a report exists. If no `agentSessionId` is present
   (a human, via browser or a human-kind session), the transition is allowed only if
   `completion_report_at IS NOT NULL` on the issue; otherwise `ValidationError` naming
   the missing `completionReport`.

This keeps the check inside `services/issues.ts::updateIssue` (single home for both
REST and MCP, per the service-layer contract) rather than duplicating it in the two
wrappers.

### Deliberately deferred

An LLM-judge pre-check (single call, pass/fail score against the spec's DoR/gating
rubric) is real but out of scope here — call it out as a follow-up ticket if pursued,
not bundled into Phase 4.

## Explicitly out of scope for this epic

Autonomous triage/grooming/status-rollup agents. Revisit once Phase 2 (flow metrics)
and Phase 4 (review gating) both exist and have run long enough to show whether
human-in-the-loop review is actually a bottleneck worth automating around — automating
triage before we can measure its effect would be exactly the kind of ungrounded
process change this epic is trying to avoid.
