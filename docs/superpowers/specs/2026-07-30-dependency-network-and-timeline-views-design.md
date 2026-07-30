# Dependency network view + timeline/roadmap view: triage and design for PROJ-479

PROJ-479 captured two raw feature ideas from an awesome-list/competitor scan and explicitly
deferred triage: *"does either fit projektor's 'agent-first' positioning, or are these purely
human-UX additions?"* This doc answers that question per idea and then designs each one against
the code as it exists today, not against a generic issue-tracker mental model.

**Headline verdicts, up front:**

| Idea | Verdict | One-line reason |
|---|---|---|
| Dependency network view | **Build — and it is agent-first, not human-UX** | The graph traversal is *already* load-bearing agent infrastructure (`get_prioritized_issues` weights a 1-hop degree count at 40%), it is just shallow and — per the finding below — probably pointing the wrong way. The human view is a thin consumer of the service that fixes it. |
| Timeline/roadmap view | **Kill as framed; defer. Narrow counter-proposal below** | A Gantt is plan-first. `issues` has **no planned dates and no estimate column at all**, and the only instance that exists has **zero sprints**. The real ask underneath is a new planning data model — a product decision, not a view. |

> **Doc-location note:** `AGENTS.md` says design records belong in the projektor wiki, not a repo
> `docs/` folder. The four commits preceding this one put design docs in
> `docs/superpowers/specs/` anyway, and this doc follows that precedent for consistency. Which
> convention actually holds is open question 10 — it should be settled once rather than drifting
> further.

## What was verified in the codebase (not assumed)

Everything below is read from source at `63169ce`, plus one live read of the dogfood workspace.

**Dependency data:**

- `issue_links` (`packages/db/migrations/0008_issue_links.sql`,
  `packages/db/src/schema/issues.ts:175`) stores `(source_issue_id, target_issue_id, type)` with
  `type IN ('blocks', 'relates_to', 'duplicates')`. It is **workspace**-scoped, not
  project-scoped — a link may cross project boundaries.
- `blocked_by` is input sugar only. `canonicalize()`
  (`apps/api/src/services/issue-links.ts:46`) rewrites `A blocked_by B` to `B blocks A`, and
  canonicalises the symmetric types by lexicographic id order. So in stored rows,
  **`source` blocks `target`** — the *target* is the blocked one.
- `createLink` validates: not-self-link, both issues in workspace, project write access on both
  ends, and no duplicate `(source, target, type)` triple. It performs **no cycle detection**.
  The `blocks` relation can therefore already contain cycles in live data.
- Hierarchy (`issues.parent_id`, migration `0003`) *is* guaranteed acyclic: `validateParent`
  (`apps/api/src/services/issues.ts:62`) walks the ancestor chain rejecting cycles and caps depth
  at 5.
- Read surface today is strictly per-issue and linear: `listLinksForIssue`
  (`services/issue-links.ts:182`) → `GET /api/issues/:id/links` + `list_issue_links`. There is no
  multi-issue or transitive read anywhere.

**The graph is already agent infrastructure — and looks inverted.** `getPrioritizedIssues`
(`services/issues.ts:1435`) calls `computeInDegree` (`:1353`) and folds it into the score as
`composite = 0.4 * centrality + 0.4 * priority + 0.2 * (1 / storyPoints)`. Two defects fall out
of reading it next to `canonicalize()`:

1. **No type filter.** `computeInDegree` counts *every* link row targeting the issue, including
   `relates_to` and `duplicates`, which are not dependencies. They inflate "centrality" with
   noise.
2. **Direction looks backwards for the stated purpose.** In-degree is counted on
   `target_issue_id`, and the target of a `blocks` row is the *blocked* issue. So
   `centrality` is "how many things block me", and a 40% weight on it pushes the issues with the
   **most open blockers** — the least startable work — toward the top of "what should I work on
   next?". A bottleneck in the sense PROJ-479 means ("blocks the most other work") is
   *out*-degree on `source_issue_id`. This is called out as a finding, not fixed unilaterally:
   see open question 1.

**Time data — the decisive finding for idea 2:**

- `issues` (`packages/db/src/schema/issues.ts:70`) has **no `start_date`, no `due_date`/
  `target_date`, and no `estimate`/duration column.** Its time columns are `created_at`,
  `updated_at`, and write-once *actuals*: `completed_at` (0022), `ready_at`/`claimed_at`/`done_at`
  (0023), `in_review_at` (0029), `completion_report_at` (0025). Every one of those is stamped on
  a transition — there is not a single planned-date field in the schema.
- Story points are not a column. They are an optional custom field discovered by a
  `LIKE '%story%' OR '%point%'` heuristic over `custom_field_definitions.key`/`label`
  (`computeStoryPoints`, `services/issues.ts:1379`) — usable as a rough weight, not as a duration.
- The only planned dates that exist are `sprints.start_date` / `sprints.end_date`, both
  **nullable** (`packages/db/src/schema/sprints.ts`).
- **`list_sprints` on the dogfood project (`PROJ`) returns `{ "items": [] }`.** The sprint feature
  is built (service, routes, MCP, `SprintManager.tsx`, a nav tab) and entirely unused on the only
  live instance. A roadmap view over sprints would render an empty chart today.
- Epics are not a table: an epic is an issue whose task type has `key === "epic"`, with children
  by `parent_id` — the definition `EpicList.tsx:272` uses. `computeChildRollup`
  (`services/issues.ts:~345`) already returns `{ total, byStatus, done, remaining }` per parent.
- **A time-series view largely already ships.** `get_flow_metrics` returns `wipOverTime`,
  `throughputOverTime`, `cfdOverTime`, `arrivalVsCompletionOverTime` with day/week bucketing,
  rendered in `MetricsDashboard.tsx` via uPlot.

**Frontend architecture (both views must fit this):**

- Astro static pages (`apps/web/src/pages/*.astro`) mounting Preact islands with `client:load`.
  No SPA router; no server-side data fetching — every island fetches on mount through
  `apiFetch`/`buildHeaders` (`utils/api-client.ts`). Raw `fetch(` in an island is a CI failure
  (`scripts/check-island-api.mjs`).
- The Issues page already has pluggable view modes: `issue-list/BoardView.tsx`,
  `ListSection.tsx`, `BacklogView.tsx`, switched by `Toolbar.tsx` over shared filter state
  (`useIssueFilters`, `useFilterUrlSync`, `useIssueFetching`).
- Charting deps already present: **`mermaid` ^11** (hydrated from ```` ```mermaid ```` fences by
  `utils/markdown.ts:renderMermaid`, used in wiki/issue/share bodies) and **`uplot` ^1.6**
  (wrapped by `islands/charts/UplotChart.tsx`, theme-aware via a `data-theme` MutationObserver).
- `code-heatmap` is the closest existing precedent for what idea 1 needs: a read-only derived
  aggregate as `services/code-heatmap.ts` → REST + `get_code_heatmap` MCP tool →
  `islands/charts/CodeHeatmap.tsx`. Copy that shape.

**Constraints that shape both designs:** every query scoped by `workspace_id`; project-scoped
lists filtered through `visibleProjectPredicate` (`services/access.ts`); and **any variable-length
`inArray` must go through `inChunks`** or it dies on real D1's 100-bound-parameter cap while
passing CI (`AGENTS.md`, `services/sql.ts`).

---

## Idea 1: Dependency network

### Triage verdict: agent-first. Build it — service first, view second.

PROJ-479 framed this as "a visual graph… beyond the existing linear issue-link list", which reads
as human UX. That framing undersells it. The load-bearing part is not the picture; it is the
**graph query**, and projektor already depends on a broken half-implementation of that query for
its most agent-native tool. Three questions an agent asks constantly are graph queries that
**cannot be answered with the current API at all**:

- *"What can I actually start right now?"* — needs "issues with zero open `blocks` predecessors".
  Today an agent would have to call `list_issue_links` once per candidate issue and reason about
  effective direction itself.
- *"What unblocks the most work if I do it?"* — needs transitive out-reachability. Not expressible
  today at any number of calls without the agent reimplementing traversal client-side.
- *"Is this dependency set even coherent?"* — `createLink` has no cycle guard, so a fleet of
  agents linking issues can produce a deadlocked cycle that nothing detects and no human sees.

That is the answer to PROJ-479's triage question for this idea: an agent asking "what should I
work on" wants **the graph**, not a rendering of the graph. The human view is worth building too,
but it is the cheap second consumer of a service whose primary customer is the MCP surface.

### Data model implications: none

No new tables, no new columns. `issue_links` + `issues.parent_id` + the existing indexed status
columns are sufficient. Specifically:

- `issue_links_source_idx` and `issue_links_target_idx` already exist (migration 0008) — both
  traversal directions are indexed.
- `issues_parent_idx` exists for the hierarchy edges.
- Cycle handling is a **service concern, not a schema constraint**. Since live data may already
  contain `blocks` cycles, the traversal must be cycle-tolerant and must *report* cycles as a
  first-class output. Retro-fitting rejection into `createLink` is a separate decision with a
  data-audit attached (open question 2) — do not bundle it here.

### New service: `services/dependency-graph.ts`

Own domain, own five files, per the `AGENTS.md` layout table (so it is a clean single-worker
fleet assignment and does not collide with the `issues`/`issue-links` owners beyond the shared
`routes/mcp.ts`/`index.ts` serialisation).

```ts
getDependencyGraph(ctx, {
  projectId: string,          // required — graph is project-rooted
  rootIssueId?: string,       // optional: ego-graph around one issue instead of whole project
  depth?: number,             // hops from rootIssueId (default 3); ignored without rootIssueId
  includeDone?: boolean,      // default false — done/cancelled dropped
  includeRelated?: boolean,   // default false — relates_to edges omitted
  includeHierarchy?: boolean, // default true  — parent_id edges included
}) => {
  nodes: Array<{
    id, ref,                     // "PROJ-42"
    title, statusCategory, priority, assigneeName,
    sprintId, parentId, storyPoints,
    blockedByOpenCount,          // in-degree over open `blocks` predecessors
    blocksOpenCount,             // out-degree over open `blocks` successors
    downstreamOpenCount,         // transitive successors — the real bottleneck measure
    onCriticalPath: boolean,
    external: boolean,           // in another project, pulled in as a boundary node
  }>,
  edges: Array<{ from, to, kind: "blocks" | "parent" | "relates_to" }>,
  criticalPath: { nodeIds: string[], totalWeight: number },
  cycles: string[][],            // each entry an ordered node-id cycle
  dataQuality: { duplicateLinks: Array<{ from, to }> },
  stats: { nodeCount, edgeCount, rootCount, truncated: boolean },
}
```

Semantics worth pinning down explicitly:

- **`edges` uses stored direction throughout**: `from` blocks `to`. No per-viewer perspective
  flipping like `listLinksForIssue` does — a graph has no single viewpoint, and re-deriving
  `blocked_by` per node is exactly the ambiguity that produced the `computeInDegree` defect.
- **`duplicates` edges are excluded from the graph** and reported under `dataQuality` instead. A
  duplicate is a cleanup signal, not a dependency (open question 9).
- **Critical path** = longest weighted path over the `blocks` DAG, weight = `storyPoints ?? 1`
  (same heuristic source as `computeStoryPoints`, reused not reinvented). Cycles are condensed to
  a single pseudo-node before the longest-path pass, so a cyclic set degrades the answer locally
  instead of hanging the traversal. `totalWeight` is in story points, **not days** — there is no
  duration data in the schema and the output must not imply there is.
- **Cross-project boundary nodes**: because `issue_links` is workspace-scoped, a project graph
  legitimately has edges leaving the project. Include those neighbours **one hop only**, flagged
  `external: true`, and filter them through `effectiveProjectRole`/`visibleProjectPredicate` so an
  issue in an ungranted project never appears (not even its ref — same "hide existence" rule as
  `listLinksForIssue`). Dropping them silently would hide precisely the bottleneck this feature
  exists to find.
- **Hard node cap** (proposal: 500) with `stats.truncated = true`. Above that, a Worker's CPU
  budget and a human's ability to read the picture both fail; better to say so than to time out.

### Query plan (the D1 part that will bite if ignored)

Bounded query count, traversal in JS — mirroring `computeInDegree`'s existing shape rather than
inventing a recursive CTE:

1. One query: all issues in the project matching the status filter, with the
   `visibleProjectPredicate` guard — the same shape as `fetchOpenIssuesForPrioritization`.
2. **`inChunks`** over that id set: all `issue_links` rows where `source_issue_id` OR
   `target_issue_id` is in the set. This array scales with open-issue count, so it is a guaranteed
   D1 blow-up if bound directly — and, per `AGENTS.md`, invisible in tests because the vitest
   runner's SQLite cap is 32766.
3. **`inChunks`** over the external neighbour ids discovered in (2), to hydrate boundary nodes.
4. `inChunks` over the id set for story-point custom-field values — reuse `computeStoryPoints`
   rather than duplicating the `LIKE` heuristic.
5. BFS/topological work entirely in the Worker over the in-memory adjacency.

`parent_id` edges need no extra query: `parentId` is already on every row from (1). Parents
outside the result set (e.g. a done epic with open children) become `external` boundary nodes via
(3).

### API and MCP surface

Full REST↔MCP parity — this is a plain read, so there is no reason for an exception.

| Surface | Shape |
|---|---|
| REST | `GET /api/projects/:projectId/dependency-graph?rootIssueId=&depth=&includeDone=&includeRelated=` |
| MCP | `get_dependency_graph` — same params, same payload |

The MCP tool description should lead with the agent questions, in the style
`get_code_heatmap`/`get_flow_metrics` already use:

> Dependency graph over `issue_links` (`blocks`) and `parent_id` hierarchy for a project. Answers
> "what can I start now" (`nodes[].blockedByOpenCount === 0`), "what unblocks the most work"
> (`downstreamOpenCount`, `criticalPath`), and "is this dependency set coherent" (`cycles` —
> non-empty means a deadlocked link set that needs a human). Weights are story points, **not
> days**; projektor stores no durations. `duplicates` links are reported under `dataQuality`, not
> as edges.

**Second, dependent change (not the same task):** once this service exists, fix
`get_prioritized_issues` to consume it — filter to `blocks` only, and use `downstreamOpenCount`
(bottleneck) rather than blocker count, plus an `onCriticalPath` boost and optionally a hard
"skip anything with `blockedByOpenCount > 0`" filter alongside the existing `excludeClaimed`. That
is a **visible behaviour change to every agent's work queue** and needs the sign-off in open
question 1 before it is scheduled.

### UI sketch

**Placement: a fourth view mode on the Issues page, not a new nav tab.** `ProjectNav` already
carries seven tabs; and a dependency graph wants exactly the filter state the Issues page already
owns (project, status, sprint, assignee, labels — `useIssueFilters` + `useFilterUrlSync`). New
island `islands/issue-list/GraphView.tsx`, registered next to `BoardView`/`BacklogView` in
`Toolbar.tsx` + `types-view.ts`.

**Rendering: mermaid `flowchart LR`, generated from the payload.** Mermaid is already a
dependency, already hydrated by `utils/markdown.ts`, and already theme-handled. Generating a
flowchart string costs nothing new in bundle size — which matters against design principle 1
("fast and lightweight"):

```
flowchart LR
  subgraph EPIC_451["PROJ-451 MCP compliance"]
    n458["PROJ-458<br/>MRTR contract"]:::inprogress
    n460["PROJ-460<br/>Tasks extension"]:::todo
  end
  n461["PROJ-461<br/>subscriptions/listen"]:::todo
  n458 --> n460
  n460 --> n461
  n474["PROJ-474"]:::todo -.-> n461
  classDef critical stroke:#dc2626,stroke-width:3px
```

Encoding: node fill by `statusCategory` (reuse `categoryColor` from `board-utils` so the graph and
the board agree); `critical` class = red stroke on `onCriticalPath` nodes; solid arrow = `blocks`,
dashed = `relates_to`; `subgraph` box per epic from `parentId`; dashed grey node style for
`external: true`; story points in the node label when present. A **cycle banner** above the
diagram lists offending refs (`PROJ-12 → PROJ-40 → PROJ-12`) with a link to each — a cycle is a
data bug the user should fix, so it gets prose, not just a red edge. A `truncated` banner states
the cap and suggests narrowing filters or using `rootIssueId`.

Accepted limitations of the mermaid choice, stated so nobody is surprised: no click-through, no
pan/zoom, no incremental layout, and dagre layout quality degrades past roughly 100 nodes. That is
tolerable for a first cut and is the honest reason the node cap exists. An interactive
canvas/SVG renderer is a *later, conditional* phase — explicitly **reject** adding
cytoscape/elkjs/d3 up front (~100–300 KB) for a view whose usefulness is unproven.

**Mobile (required, not an afterthought).** A node-link diagram is unusable at 375 px, and
pinch-zoom on an SVG is not a design. Below the `sm` breakpoint, render the *same payload* as two
ordered lists: **"Critical path"** (`criticalPath.nodeIds` in order, each row = ref, title, status
chip, points) and **"Blocked"** (nodes with `blockedByOpenCount > 0`, grouped under their
blockers). That is not a degraded fallback — for "where is the bottleneck" it is arguably the
better projection, and it is the same shape the MCP tool returns. Follows the established
desktop-table / mobile-card split in `ListSection.tsx` and the tap-menu pattern in `BoardView`.

### Phasing

| Phase | Scope | Independently valuable? |
|---|---|---|
| **D1** | `services/dependency-graph.ts` + schema + REST + `get_dependency_graph` + `test/dependency-graph.test.ts` | **Yes** — agents gain three queries they cannot make today. Ship alone. |
| **D2** | Rewire `get_prioritized_issues` onto it (type filter + direction fix + critical-path boost) | Yes, but **gated on open question 1** (behaviour change for every agent). |
| **D3** | `GraphView.tsx` (mermaid) + mobile list projection + Toolbar wiring | Yes. Pure consumer of D1; no backend change. |
| **D4** | *Conditional.* Interactive renderer, click-through, pan/zoom | Only if D3 proves the view gets used. Default: don't. |

Test cases D1 must cover (per the "always add a test that confirms the behaviour" rule): a linear
chain's critical path; a diamond (longest path wins, not shortest); a deliberate cycle (reported,
no hang); a cross-project blocker for a *granted* project (appears as `external`); the same for an
*ungranted* project (absent entirely, not just unlabelled); `relates_to`/`duplicates` excluded from
`blocks` degree counts; and a >100-issue graph to exercise `inChunks` (which, per `AGENTS.md`,
will still pass under SQLite even if wrong — so also assert the chunking call shape, not only the
result).

---

## Idea 2: Timeline/roadmap view

### Triage verdict: kill as framed. The Gantt has no input data, and the agent story is thin.

A Gantt chart is a **plan-first** artifact: it needs, per item, a planned start and end — or a
duration plus dependency-driven scheduling. Projektor has none of that:

- Zero planned-date columns on `issues`. Every time column is a stamped *actual*
  (`ready_at`/`claimed_at`/`in_review_at`/`done_at`/`completed_at`).
- No estimate column. Story points exist only as an optional custom field found by a `LIKE`
  heuristic — fine as a relative weight for ordering, not as a bar length in days.
- The only planned dates in the schema, `sprints.start_date`/`end_date`, are nullable — and the
  dogfood workspace has **zero sprints**. A sprint-axis roadmap renders empty on the only running
  instance.

So PROJ-479's second bullet is really two asks welded together: **(a)** introduce a planning data
model — dates and/or estimates on issues, plus sprints actually being used — and **(b)** draw a
chart. (a) is the entire cost and the entire product decision; (b) is comparatively trivial.
Building (b) first produces an empty view; building (a) first is a positioning change that
deserves its own ticket and its own argument.

**On the agent-first question specifically: this is the weaker of the two ideas, and it is weak in
an instructive way.** Idea 1 computes something agents provably cannot compute today (transitive
reachability, critical path, cycle detection). Idea 2, in every version that fits the current
schema, **re-projects data agents already have** — `list_issues` + `get_issue` rollups +
`get_flow_metrics` already expose the underlying numbers. A Gantt is a human comprehension aid for
data an agent reads directly. If projektor *did* want a deadline-aware agent surface, the right
primitive is a `target_date` field plus a filter and a prioritisation input — not a timeline
endpoint.

**And there is a positioning tension worth naming rather than absorbing silently.** The codebase
has repeatedly chosen stamped actuals over planned inputs — 0022 (`completed_at`), 0023 (flow
timestamps), 0029 (`in_review_at`), all with migration comments explaining why an indexed
transition stamp beats deriving from history. `get_flow_metrics` measures what happened. Adding
planned start dates and duration estimates pulls in the opposite direction, toward classic human
sprint-planning ritual. That may be a trade the owner wants. It is not a trade an implementer
should make as a side effect of "add a Gantt view".

**Also: a time view largely already ships.** `get_flow_metrics` +`MetricsDashboard.tsx` already
render `wipOverTime`, `throughputOverTime`, `cfdOverTime`, `arrivalVsCompletionOverTime` on
day/week buckets. What genuinely does not exist is a **per-entity span** view — one row per epic
rather than one aggregate number per bucket. That gap is the only part of idea 2 worth building
now, and it is much smaller than "Gantt".

### Counter-proposal T1: epic delivery timeline (read-only, zero new columns)

Build this **only if a human confirms they want a timeline at all** (open question 6). It is
deliberately not a Gantt: it plots what happened, with unfinished work shown as open-ended.

**Data**, all from existing columns. For each epic (issue whose task type `key === "epic"` — the
`EpicList.tsx:272` definition), aggregate over children by `parent_id`:

```
spanStart = min(child.ready_at ?? child.created_at)
spanEnd   = max(child.done_at)  ||  now (open-ended)
rollup    = computeChildRollup(children)   // already exists: {total, byStatus, done, remaining}
```

One horizontal bar per epic on a shared time axis. Unfinished epics' bars run to "today" with a
visually open right edge. **No forecast line, no projected completion** — there is no velocity or
duration input that would not be invented, and a made-up projection in a tool whose metrics story
is "measure reality" would be actively harmful.

**Placement:** an additional section/toggle on the existing `/epics` page. `EpicList.tsx` already
fetches exactly this data (`includeRollups`, batched — see its own comment about replacing a
per-epic `getIssue` fan-out), so T1 is a rendering change over a payload the island already holds.
No new nav tab, and the table stays the default view.

**Rendering:** plain CSS grid/flex bars with `left`/`width` as percentages of the visible window.
Deliberately **not** uPlot (a series plotter; categorical spans are the wrong primitive) and
**not** mermaid `gantt` (wants fixed start+end dates and cannot express "still running,
open-ended"). Mobile: same bars stacked with explicit date labels per row, scrolling vertically —
never a horizontally-scrolling axis.

**Sprint overlay:** draw sprint boundary lines *only* if the project has at least one sprint with
both dates set; otherwise omit the furniture entirely rather than showing an empty axis. Given the
dogfood instance's zero sprints, assume this branch is usually off (open question 7).

**MCP surface: none — REST-only.** A `get_epic_timeline` tool would return `{ epicId, spanStart,
spanEnd, done, remaining }`, every field of which an agent can already obtain from
`list_issues({ parentId })` / `get_issue` rollups. Adding it buys zero agent capability and grows
the tool surface. **But note this is a new *kind* of parity exception**: every entry in
`AGENTS.md`'s "deliberate REST↔MCP parity exceptions" list today is transport- or auth-shaped
(binary upload, browser redirect, credential minting, connection bootstrap). "Pure re-projection
of data available via existing tools" would be the first *value*-shaped exception, and that is a
precedent, not a detail. If the owner would rather not open that door, add the tool for parity's
sake and accept the surface bloat — see open question 8. Either way, T1 must not ship a
surface-only feature without an explicit `AGENTS.md` entry.

### Deferred T2: `issues.target_date` — needs a product decision first

If and only if projektor is meant to carry commitments:

- One column: `target_date INTEGER` nullable, plus
  `CREATE INDEX idx_issues_workspace_target_date ON issues(workspace_id, target_date)` — following
  the 0022/0023 precedent of an indexed stamped column over derive-on-read.
- Surfaces: `update_issue`/`create_issue` accept it; `list_issues` filters on it; `get_issue`
  returns it.
- **Do not add `start_date` or `estimate_days`.** One target date is the minimum that buys
  anything; a full plan model is a much larger commitment and should be argued separately.
- The one genuinely agent-actionable payoff, and the only version of idea 2 with a real agent
  story: **cross T2 with idea 1** — flag an issue "at risk" when its `target_date` is in the past,
  or when it sits on a critical path whose remaining weight cannot plausibly land before that
  date. That is a signal an agent can act on, and it is impossible without both halves.
- Everything about a *plan* Gantt (dependency-driven scheduling, baseline vs actual, slack) stays
  out of scope indefinitely. Nothing in the current usage pattern justifies it.

---

## Sequencing across both ideas

```
D1  dependency-graph service + REST + MCP            ← start here; standalone agent value
 ├─ D2  rewire get_prioritized_issues                ← gated on open question 1
 └─ D3  GraphView (mermaid) + mobile list projection  ← pure consumer of D1
        └─ D4  interactive renderer                   ← conditional, default no

T1  epic delivery timeline on /epics                 ← gated on open question 6; independent of D*
 └─ T2  issues.target_date                           ← gated on a product decision; only then:
        └─ "at risk" signal = T2 × D1                 ← the only agent-facing timeline payoff
```

D1 is unambiguously first: it is the only item here that gives agents a capability they lack, it
needs no new schema, and every other dependency-side item consumes it. T1 is independent and
cheap but should not be started before somebody confirms a timeline is wanted — the honest default
for idea 2 is **defer**, and "defer" is a legitimate outcome of this triage rather than a failure
of it.

## Open questions for human review

1. **Is `computeInDegree`'s direction intentional?** Reading it with `canonicalize()`, the
   40%-weighted "centrality" term appears to reward issues with the *most blockers* — the least
   startable. Fixing it (filter to `blocks`, switch to downstream reach) changes the ordering
   every agent sees from `get_prioritized_issues`. Confirm the intent and approve/reject the
   change before D2 is scheduled.
2. **Cycle policy.** Proposal: report-only, since live data may already contain `blocks` cycles.
   Should `createLink` additionally *reject* cycle-creating links going forward — and if so, does
   that need a data audit of existing links first?
3. **Cross-project boundary nodes.** Proposal: include one hop, flagged `external`, access-
   filtered. Alternative is hard-scoping to the project, which hides real external blockers. Which?
4. **Node cap.** Is 500 right, and on truncation should the service prefer nodes nearest the
   critical path over an arbitrary cut?
5. **Graph placement.** Proposal: a view mode on Issues (shares filter state; nav already has 7
   tabs). Alternative: its own tab. Confirm.
6. **Does projektor want a timeline at all?** T1 is cheap but is a human comprehension aid, not an
   agent capability. Explicit go/no-go, please — "no" is a fine answer and closes idea 2 cleanly.
7. **Are sprints deliberately dead?** Zero sprints exist on the dogfood instance. If sprints are
   not going to be used, the sprint-overlay part of T1 drops and the Sprints nav tab is arguably
   its own cleanup ticket.
8. **Is REST-only acceptable for a pure re-projection (T1)?** It would establish the first
   *value*-shaped REST↔MCP parity exception. Accept the precedent, or add the tool for parity?
9. **Should `duplicates` links appear in the graph?** Proposal: no — reported under `dataQuality`
   as a cleanup signal. Confirm.
10. **Where do design docs live?** `AGENTS.md` says the wiki; the last four commits say
    `docs/superpowers/specs/`. Settle it, since the drift is now four docs deep.

## Verification

This doc is the artifact for PROJ-479's product triage. No code changes are proposed here, and no
projektor issues were created or modified — turning D1/D2/D3 and T1 into tickets is the follow-up
action for the human, after the open questions above are answered.

Readiness differs per item, deliberately:

- **D1 (dependency-graph service)** is the closest to implementation-ready. It needs open
  questions 2, 3, 4 and 9 answered, but none of those change its shape — they set defaults. It is
  a clean single-worker fleet assignment: one new domain, five new files, plus the serialised
  `routes/mcp.ts` / `index.ts` edits.
- **D2** is not ready and must not be bundled with D1: it is a behaviour change to every agent's
  work queue, blocked on open question 1.
- **D3** is ready once D1 lands and needs no further design; the mermaid + mobile-list-projection
  decisions above are sufficient to scope it.
- **T1** is designed but **gated on a product decision** (open question 6), not on any technical
  unknown.
- **T2 and the Gantt as originally framed** are not ready and should stay in the backlog
  unprioritised. Recommend PROJ-479 be closed by splitting out D1 (and D3) as real tickets while
  recording the timeline half as explicitly deferred with the reasoning above — rather than
  leaving a raw idea ticket open to be re-triaged from scratch later.
