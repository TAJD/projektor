# PROJ-431 — PWA mobile performance: design

Date: 2026-07-26
Ticket: PROJ-431
Prior context that constrains this work: PROJ-430 (`fe2eb16`), PROJ-427, PROJ-414.

## What is slow today, measured

Harness: `apps/web/perf-measure.mjs` (throwaway). Serves the built `dist/` over a
local server with brotli/gzip — matching how Cloudflare serves these assets — and
proxies `/api` and `/auth` to the live dogfood Worker, so the numbers include real
API latency. Chromium via Playwright, Pixel 5 device profile, Lighthouse mobile
throttling (1.6 Mbps down / 750 Kbps up / 150 ms RTT, 4× CPU). Median of 3 runs.
"content" is time until the page shows something other than the `Loading…`
placeholder.

| profile | page | FCP | LCP | JS done | API done | content |
|---|---|---|---|---|---|---|
| mobile | `/issues/view` | 604 ms | 5976 ms | 3653 ms | 5641 ms | **6160 ms** |
| mobile | `/` (projects) | 812 ms | 2312 ms | 1200 ms | 3114 ms | **3065 ms** |
| desktop, unthrottled | `/issues/view` | 196 ms | 2500 ms | 1326 ms | 2440 ms | 2512 ms |
| desktop, unthrottled | `/` | 196 ms | 772 ms | 235 ms | 2172 ms | 766 ms |

Three independent causes.

### 1. The API is the floor (~1 s per authenticated request)

On a single warm reused connection to the dogfood Worker:

| request | TTFB |
|---|---|
| static asset (`/favicon.svg`) | 109 ms |
| `/api/health` | 115 ms |
| `/api/task-statuses` | 1098 ms |
| `/api/issues/{uuid}` | 734 ms, 737 ms |
| `/api/issues/{uuid}/comments` | 957 ms |

Network RTT to the edge is ~110 ms, so ~620–990 ms is server time, for payloads
of 5.7 KiB. Counting only *blocking* D1 round trips before the route handler runs
its first query, on the browser (CF Access) path with warm isolate caches:

- `rate-limit.ts` — 2 (upsert, then a separate count `SELECT`), plus a prune
  `DELETE` at 1% probability.
- `auth.ts` → `provisionUserOnLogin` — 3. It runs on *every* request despite the
  name, and for an admin its cost is `2 + N` for N workspaces, sequentially.
- `workspace.ts` — 2 (workspace by slug, then membership).

**Seven sequential round trips**, each paying full D1 latency. Two things that are
*not* the cause, checked so they aren't re-investigated: `api_tokens.last_used_at`
is already throttled and `waitUntil`-wrapped (PROJ-360), and the JWKS keys and
`upsertUserByEmail` are served from isolate-local caches (PROJ-354).

This is the single largest lever and no frontend change fixes it; caching only
hides it. It lives in `apps/api`, outside this ticket's scope. Raised as PROJ-432,
with the provisioning finding as PROJ-433.

### 2. `/issues/view` ships CodeMirror to readers

Static module closure of the built page: 637 KiB raw / **221 KiB gzip**, of which
`MarkdownEditor` is **486 KiB raw / 168 KiB gzip — 76%**. It is a static import in
`IssueDetailParts.tsx:25`, so every reader pays for it even though it only renders
after tapping Edit. `/wiki` has the same 221 KiB gzip closure for the same reason.

### 3. First paint waits on all seven requests

`IssueDetail.tsx:203-236` gates render on `Promise.all([...]).finally(() =>
setLoading(false))`. Title and body need one request but wait behind `/api/files`,
`/api/task-statuses` and `/api/workspaces/{slug}`.

Compounding it, `useResolvedIssueId` turns a pretty URL into a UUID with a
*separate* prior request. `/api/issues/PROJ-431` and `/api/issues/{uuid}` were
verified to return byte-identical 31-key payloads, so that first response is a
complete issue that is discarded except for `.id` — a fully wasted serial round
trip on the canonical URL form.

### 4. The service worker precaches 4.17 MiB

111 entries, 4.17 MiB, including `mermaid.core` (579 K), `cytoscape.esm` (433 K),
`katex` (255 K), `cynefin` (672 K) and every diagram chunk. All are already
dynamically imported and used only by the wiki. This downloads on install and
re-downloads changed entries on every deploy.

## Constraints carried forward from PROJ-430

Non-negotiable, and asserted by tests:

- No `navigateFallback`. The explicit `navigateFallback: undefined` stays, because
  `vite-plugin-pwa`'s `defaultWorkbox` hard-codes `'index.html'` and merges with
  `Object.assign` — omitting the key re-enables it.
- No HTML in the precache; navigations must reach the network so Cloudflare Access
  can challenge.
- `/api` and `/mcp` stay `NetworkOnly`.
- Verified against the built `dist/sw.js`, not the config.

No offline app shell is reintroduced. For an Access-gated app, offline means
logged out, and PROJ-414's offline banner already covers that state.

## Changes

### C1 — Seed issue state from the resolve response (`IssueDetail.tsx`)

`useResolvedIssueId` returns the full issue it already fetched, not just the id.
`useIssueCore` accepts it as initial state. The UUID-keyed fetch still runs and
revalidates; it is simply no longer in front of first paint.

### C2 — Render on the core request (`IssueDetail.tsx`)

`if (loading) return <Loading/>` becomes `if (loading && !issue)`. Downstream
components already degrade: `StatusField` renders a read-only label when
`statuses` is empty and upgrades to a `<Select>` when it arrives.

### C3 — Lazy-load the editor (new `LazyMarkdownEditor.tsx`)

`preact/compat` `lazy` + `Suspense`, substituted at the three static import sites
(`IssueDetailParts.tsx`, `issue-list/CreateIssueModal.tsx`, `WikiPage.tsx`).

The `Suspense` fallback is a real `<textarea>` bound to the same `value`/`onChange`
contract, not a spinner, so typing works immediately on a slow connection.
`MarkdownEditor`'s existing external-`value` sync effect handles the handoff when
the chunk lands.

Known edge, accepted: caret position and focus are lost at the swap.

### C4 — Trim the precache (`astro.config.mjs`)

`globIgnores` for the lazy vendor chunks. They still load on demand over the
network. Target: install payload under 1 MiB, from 4.17 MiB.

Guarded by a **precache byte-budget test** against the built `sw.js`, which is what
actually prevents regression — glob patterns alone are brittle to chunk renames.

### C5 — Two mobile editing defects

- Toolbar buttons are `py-[2px]` at `0.8rem` — roughly 24 px tall, against a 44 px
  touch-target guideline. Raised to a 44 px target on small screens only, so the
  desktop toolbar is unchanged.
- Editor content is `0.875rem` (14 px) and the comment textarea is `text-sm`. Below
  16 px, iOS Safari zooms the viewport on focus, and the viewport meta sets no
  `maximum-scale`. Raised to 16 px on small screens only.

### C6 — Draft persistence (new `utils/drafts.ts`)

Debounced save of in-progress comment and issue-body text to `localStorage`,
restored on return, cleared on successful submit.

- Keys are namespaced and **workspace-scoped**: `projektor:draft:<workspace>:<scope>`.
- Entries carry a timestamp and **expire after 7 days**.
- Storage failures (private mode, quota) degrade silently to no persistence.

Trade-off, stated explicitly: this puts user-typed text on disk, which is in mild
tension with the "nothing private at rest" reasoning behind the in-memory cache
decision below. Treated differently because a draft is the user's own *unsent*
input and losing it is the concrete pain the ticket names, whereas cached issue
data is *fetched* private data carrying tenant-leak and staleness surface.

## Recommended, deliberately not built

### Local caching of issues/projects — in-memory stale-while-revalidate

The recommendation is a module-scoped SWR cache that **dies with the tab**, not
IndexedDB.

Rationale. The measurements show the API costs ~1 s per request, so the win from
caching is real — but it is a *within-session* win: instant back-navigation and
instant re-open of a recently viewed issue. Surviving a cold start buys much less
here, because a cold start is exactly when an Access session may need re-challenging.

It also answers the ticket's three auth questions for free rather than by
mechanism:

- **Logout / expiry** — nothing is written to disk, so nothing outlives the tab.
  No teardown path to get wrong.
- **Workspace scoping** — cache keys include the workspace slug; a tab only ever
  holds one workspace's data anyway.
- **Staleness** — stale-while-revalidate always issues the network request and
  repaints on the response, so a cached issue is a head start, never a final
  answer.

IndexedDB is the alternative worth naming. It wins on cold start and is the right
answer if the app ever needs to be genuinely usable offline. It costs an explicit
teardown on 401/logout, a workspace-scoped database name, a schema version, and
leaves private data at rest on a phone that may be shared or lost. Not worth it
while offline means logged out.

Raised as PROJ-434. Worth re-measuring whether it still pays for itself once
PROJ-432 lands — if authenticated requests drop from ~1s to ~200ms, the perceived
win shrinks. Sequence it second.

### API middleware round trips

See "1. The API is the floor". Largest available win. PROJ-432, with PROJ-433
under it.

## Verification

- `cd apps/web && pnpm vitest run` — full web suite green
- `pnpm turbo type-check` — 7/7
- `pnpm biome check` — clean (invoke biome directly; rtk rewrites `pnpm biome`)
- `pnpm --filter @projektor/web build`, then assert against `dist/sw.js`:
  no `NavigationRoute`, no `createHandlerBoundToURL`, `NetworkOnly` on `/api|/mcp`,
  precache under budget
- Re-run `perf-measure.mjs` before/after and report both mobile and desktop
- Interactive changes exercised at 375 px and desktop widths
