# Feedback page layout redesign (PROJ-429)

## Problem

The `/feedback` page (`apps/web/src/pages/feedback.astro`) stacks three independent islands — `FeedbackSourceManager` (source CRUD table), `FeedbackSummary` (per-source/per-version stats), `FeedbackList` (flat table of every feedback item across every source) — vertically on one page. Everything for every source renders inline, all the time. This doesn't scale as sources are added: the page gets longer and noisier per source, and there's no way to focus on one source at a time.

## Goals

- Top-level view: a summary card per feedback source (name, status, volume, last activity) plus a way to create a new source.
- Navigate from a card into a focused detail view for that source (items, stats, token/settings) instead of rendering everything flat.
- Reuse existing UI patterns (card grid, `Select` component, ARIA tabs, dynamic detail routes) rather than inventing new ones.
- No backend/API/schema changes — this is a client-side reorganization of existing data.

## Non-goals

- No changes to the feedback data model, ingestion (`/api/feedback/submit`), or MCP tool surface.
- No changes to `ProjectNav` (the "Feedback" top-nav tab still points at `/feedback`).

## Design

### Top-level page — `/feedback`

- Responsive card grid, same visual pattern as `ProjectGrid`/`ProjectCard` in `ProjectList.tsx` (CSS grid, `repeat(auto-fill, minmax(280px, 1fr))`).
- One card per source: name, active/revoked badge, total feedback count, last-activity timestamp. Revoked sources stay visible in the grid, rendered visually muted (not hidden) — same visibility principle as today's manager table.
- Trailing "+ New source" card. Clicking it opens a modal (`NewSourceModal`) with the existing create-source fields (name, description, allowed origins) and validation. On success: close modal, refetch grid.
- Clicking any source card navigates to `/feedback/[sourceId]`.
- New `FeedbackSourceGrid` island replaces the three stacked islands on this page. `feedback.astro` becomes: `ProjectNav` + `FeedbackSourceGrid`.

### Detail page — `/feedback/[sourceId]`

- New dynamic Astro route, same shape as the issue-detail page: `getStaticPaths` returns `[]`, the island resolves `sourceId` from the URL client-side.
- Header: source name, status badge, and a `Select`-component dropdown listing all sources in the project so the user can jump between sources without returning to the grid.
- Three ARIA tabs, reusing the tabs pattern from `GroupManager.tsx` (`role="tablist"/"tab"/"tabpanel"`, arrow-key/Home/End navigation):
  - **Items** — `FeedbackList`, adapted to take a fixed `sourceId` prop instead of iterating/filtering across all sources. Status filter remains. Its native `<select>` filters are swapped for the shared `Select` component while the file is being touched anyway.
  - **Summary** — `FeedbackSummary`, adapted to render one source's version-by-version stats (currently it already renders per-source blocks; scope it to a single source).
  - **Settings** — token rotate/reveal/revoke and active-toggle controls, extracted from `FeedbackSourceManager`'s per-row action set into a focused per-source settings panel.

### Data flow

No backend changes. Existing endpoints already support what's needed:
- `GET /api/projects/:id/feedback-sources` — list, used by the top-level grid.
- `POST /api/projects/:id/feedback-sources` — create, used by `NewSourceModal`.
- `PATCH` / `rotate` / `DELETE` on `/feedback-sources/:sourceId` — used by the Settings tab.
- `GET /api/projects/:id/feedback?sourceId=...&status=...` — used by the Items tab (the endpoint already accepts a `sourceId` filter).
- `GET /api/projects/:id/feedback/summary` — used by the Summary tab, filtered client-side to the current `sourceId` (or scoped server-side if a query param already exists — confirm during implementation; add one only if trivial, otherwise filter the returned array client-side).

### Components

| Change | File |
|---|---|
| New | `apps/web/src/pages/feedback/[sourceId].astro` |
| New | `apps/web/src/islands/FeedbackSourceGrid.tsx` |
| New | `apps/web/src/islands/NewSourceModal.tsx` |
| New | `apps/web/src/islands/FeedbackSourceDetail.tsx` (tabs shell + dropdown) |
| Rewritten (slimmed) | `apps/web/src/pages/feedback.astro` |
| Adapted | `apps/web/src/islands/FeedbackSourceManager.tsx` → split into grid-card data fetch (feeds `FeedbackSourceGrid`) and settings-tab logic (feeds the Settings tab) |
| Adapted | `apps/web/src/islands/FeedbackSummary.tsx` → accept single `sourceId`, render one source's version stats |
| Adapted | `apps/web/src/islands/FeedbackList.tsx` → accept fixed `sourceId`, swap native `<select>`s for shared `Select` component |
| Unchanged | `apps/web/src/islands/ProjectNav.tsx`, all `apps/api` routes/services, DB schema |

## Testing

- Manual verification via dev server + claude-in-chrome, both desktop and mobile viewport widths:
  - Grid renders one card per source with correct name/status/volume/last-activity.
  - "+ New source" modal creates a source and it appears in the grid.
  - Clicking a card navigates to its detail page; the source dropdown switches between sources without a full page reload feel.
  - Each tab (Items / Summary / Settings) renders correctly scoped data; tab keyboard navigation (arrow keys/Home/End) works.
  - Settings tab: rotate/revoke/active-toggle still work as before.
  - Revoked sources appear muted in the grid and are still reachable.
- No automated test suite changes are in scope unless existing tests directly assert on the old flat-page structure (check `apps/web` test files touching `feedback.astro`/these islands before implementing).
- Check for mobile and for desktop - lean on existing tests.
