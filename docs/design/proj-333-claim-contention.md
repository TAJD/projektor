# Claim contention / parallelism ceiling (PROJ-333)

Status: design-only. No implementation lands with this doc; see Follow-up tickets below.

## Motivation

Fleet parallelism is capped by choke points: files multiple agents want to touch at
once. `claimFiles` (`apps/api/src/services/file-claims.ts`) already enforces this —
`assertNoConflicts` throws a `ConflictError` naming the path and the holding issue/agent
— but the event itself is thrown away. The caller sees an error and (per `AGENTS.md`
fleet protocol) picks a different task; nothing durable records that the attempt
happened. Today there is no way to answer "which files are actually contended, and how
often" — exactly the signal that would tell an operator sizing a fleet where the
ceiling is.

## The decision: record rejected attempts, not derive from overlap

Two candidate designs:

**A. Record rejected claim attempts.** At the point `assertNoConflicts` (or
`overrideConflictingClaims`, for `force`) discovers a conflict, write a row: the
contended path, the rejected issue/agent, the holding issue/agent, and a timestamp.

**B. Derive contention from temporal overlap of granted claims.** Post-hoc, scan
`issue_file_claims` for rows on the same path with overlapping `[claimedAt,
releasedAt)` windows.

**Recommendation: A.**

- **B can't see the actual signal.** `claimFiles` is all-or-nothing and pre-checks
  before inserting (line 151-155) — a conflicting request is never written to
  `issue_file_claims` at all. There is nothing to derive overlap from; the rejected
  attempt leaves no row. B would only ever see claims that were serialized *after*
  waiting for a release, which is a different (weaker) signal than "two agents wanted
  this file at the same time."
- **A is strictly cheaper to compute correctly.** The conflict is already fully
  resolved in-process at the point of rejection — path, rejecting issue, agent,
  holding issue, agent are all local variables in `assertNoConflicts`/
  `overrideConflictingClaims`. Capturing it is a single insert next to work already
  done. B would require a windowed self-join over `issue_file_claims` per path, rerun
  whenever the heatmap or a contention view is requested — real query cost for a signal
  A gets for free.
- **A also captures `force` overrides**, which are the *sharper* signal (an agent chose
  to evict another issue's claim, not just wait), and B can partially see those (the
  overridden claim's `released_at`/`release_reason = 'overridden'`, from PROJ-334)
  but conflates them with ordinary releases without a dedicated column.

This mirrors the precedent set by PROJ-334's `issue_gate_rejections` table: `AGENTS.md`
review-bounce counts already existed as a running total on `issues`, but answering
"how many in this date range" needed a real event log, not a derived aggregate. Same
shape here — `assertNoConflicts` could bump a counter, but a windowed "how contended is
this file *this week*" query needs timestamped rows.

## Schema

New table, following the `issue_gate_rejections` (0031) pattern — workspace-scoped,
FK'd to the issues involved, indexed for windowed queries:

```sql
CREATE TABLE claim_conflicts (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	rejected_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
	rejected_agent_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
	holding_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
	holding_agent_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
	forced INTEGER NOT NULL DEFAULT 0, -- 1 when this was an override (force: true), not a hard rejection
	occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_claim_conflicts_workspace_occurred ON claim_conflicts(workspace_id, occurred_at);
CREATE INDEX idx_claim_conflicts_path ON claim_conflicts(workspace_id, path);
```

`rejected_agent_id`/`holding_agent_id` are nullable exactly like
`issue_file_claims.agent_id` today (a claim can be issue-only, no agent session
attached). No `release_reason`-style enum needed — `forced` is the only branch in
`claimFiles` that distinguishes hard-reject from override.

## Retention / PII

No PII concern: `agent_sessions` rows are internal fleet-tooling identifiers (agent
session UUIDs scoped to a workspace), not end-user data, same conclusion already
reached for `issue_file_claims` and `issue_gate_rejections`. This is purely a
storage-growth question — a busy fleet could write one row per rejected `claim_files`
call, which is bounded by fleet size and issue volume, not user traffic, so growth is
slow relative to `issue_file_claims`/`issue_comments`. No TTL/sweep needed at launch;
revisit only if a workspace's row count becomes large enough to slow the windowed
query (same bar `issue_file_claims` and `issue_gate_rejections` are held to — neither
has a sweep today).

## UI surface

Overlay on the existing codebase heat map (PROJ-332, `code-heatmap.ts` /
"Where work lands" panel), not a separate panel. The heat map already answers "which
paths get claimed" by grouping `issue_file_claims` into a directory tree with
`distinctIssueCount`/`claimCount` per segment; contention is the same tree with a
different metric (`conflictCount` from `claim_conflicts`, grouped by the same
`groupClaimsByNextSegment` path-segment logic). Reusing the tree means no new
drill-down UI — a toggle on the existing panel between "claim volume" and "contention"
coloring, sharing the same `prefix`-based navigation. A standalone panel would
duplicate the directory-tree component for a metric that answers the same underlying
question ("where does the fleet queue up") from a different angle.

## Explicitly out of scope for this design

- Any live/real-time contention alerting (e.g. paging when a path is rejected N times
  in an hour) — the event log makes this possible later, but it's a consumer of the
  data, not part of capturing it.
- Automatically raising/lowering `agent_wip_limit` (PROJ-250 Phase 3) based on
  contention — flagged as a natural follow-up once contention data exists, not bundled
  here.

## Follow-up implementation tickets

### Ticket 1: Record claim conflicts on rejection/override

Body:

> Add a `claim_conflicts` table and write a row from `file-claims.ts` whenever
> `claimFiles` rejects a conflicting path (or overrides it under `force`) — the signal
> that fleet parallelism hit a choke point, currently thrown away as an unrecorded
> `ConflictError`.
>
> **Acceptance criteria:**
> - Migration `packages/db/migrations/00XX_claim_conflicts.sql` adds `claim_conflicts`
>   per the schema in `docs/design/proj-333-claim-contention.md` (workspace-scoped,
>   FK'd to `issues`/`agent_sessions`, `forced` flag, indexed on
>   `(workspace_id, occurred_at)` and `(workspace_id, path)`).
> - `assertNoConflicts` in `apps/api/src/services/file-claims.ts` writes one
>   `claim_conflicts` row per contended path before throwing `ConflictError`
>   (`forced = 0`), with the rejecting issue/agent (from the incoming `claimFiles`
>   params) and the holding issue/agent (from `claimsByPath`).
> - `overrideConflictingClaims` writes one row per overridden path (`forced = 1`),
>   alongside the existing `postMessage`/`releasedAt` update — same loop, no new query.
> - Both paths use the same `now` already computed in `claimFiles`, so all rows from one
>   call share a timestamp.
> - Unit tests: rejecting a conflicting `claimFiles` call inserts a `claim_conflicts`
>   row with `forced = 0`; a `force: true` call that overrides an existing claim inserts
>   one with `forced = 1`; a non-conflicting call inserts none.
>
> **Scope / files:** `packages/db/migrations/00XX_claim_conflicts.sql`,
> `packages/db/src/schema/` (new table def), `apps/api/src/services/file-claims.ts`.
>
> **Verification:** `pnpm --filter api test file-claims` (or the project's standard
> vitest invocation), new tests above pass; migration applies cleanly via the project's
> standard migration-check.

### Ticket 2: Surface contention on the codebase heat map

Body:

> Add a contention view to the "Where work lands" heat map (PROJ-332) reading from
> `claim_conflicts` (Ticket 1), so an operator can see which paths are actually
> blocking fleet parallelism, not just which paths get the most claims.
>
> **Acceptance criteria:**
> - `services/code-heatmap.ts` gains a `mode: "claims" | "contention"` param (default
>   `"claims"`, preserving current behavior). In `"contention"` mode, group
>   `claim_conflicts` rows (same `windowSince`/`windowUntil` semantics as claims today)
>   by the same next-path-segment logic (`groupClaimsByNextSegment` generalized to take
>   a metric name, or a parallel `groupConflictsByNextSegment`), returning
>   `conflictCount`/`distinctRejectedIssueCount` per entry instead of
>   `claimCount`/`distinctIssueCount`.
> - Web UI: the existing heat map panel gets a toggle between "claim volume" and
>   "contention" using the shared drill-down tree component — no new panel, no new
>   route.
> - Unit tests: a `claim_conflicts` fixture with conflicts nested under a prefix groups
>   correctly at each drill-down level; an empty-conflicts workspace returns zero
>   entries without error.
>
> **Scope / files:** `apps/api/src/services/code-heatmap.ts`,
> `apps/api/src/schemas/code-heatmap.ts`, the web heat-map panel component (see
> PROJ-332's web-side files).
>
> **Verification:** `pnpm --filter api test code-heatmap`; manual click-through on the
> dogfood instance confirming the toggle renders both modes.

Both tickets depend on Ticket 1 landing first (Ticket 2 reads the table Ticket 1
creates). Both are children of the PROJ-325 epic, same as PROJ-332/334.
