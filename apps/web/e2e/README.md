# Playwright E2E — Kanban Board (PROJ-61)

End-to-end tests for the board drag-and-drop feature and its mobile guards.
These tests target a **deployed dev instance**, not a local dev server.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Node ≥ 18 | Built-in `fetch` used in global setup |
| Playwright browsers | `pnpm --filter @projektor/web exec playwright install --with-deps chromium` |
| Dev deployment | `ENVIRONMENT=development`, `DEV_USER_EMAIL` set on the Worker |

### Why a deployed dev instance?

The island makes API calls to the *same origin* (`/api/issues`, `/api/task-statuses`, …).
Locally, the API runs on `:8787` while the Astro dev server runs on `:4321`; the
relative API paths would 404.  A Cloudflare Workers dev deployment (e.g. via
`wrangler deploy --env dev`) serves both from the same origin.

### Server-side dev bypass

Auth is handled transparently: when `ENVIRONMENT=development` and `DEV_USER_EMAIL`
are set on the deployment, the API auto-authenticates every request as that user.
No credentials are needed in the test runner itself.

---

## Running the suite

```bash
# Point at your dev deployment:
export E2E_BASE_URL=https://your-dev-instance.workers.dev

# (From monorepo root)
pnpm --filter @projektor/web exec playwright test

# Run a single project:
pnpm --filter @projektor/web exec playwright test --project=desktop
pnpm --filter @projektor/web exec playwright test --project=mobile

# Show the HTML report:
pnpm --filter @projektor/web exec playwright show-report
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `E2E_BASE_URL` | **Yes** | Root URL of the dev deployment. API must be at `<url>/api/*`. |

---

## What the tests do

### Global setup (`e2e/global-setup.ts`)

Runs **once** before any test worker.  Creates a fresh, isolated workspace on the
deployment:

1. `POST /api/workspaces` → workspace slug `e2e-<timestamp>`
2. `POST /api/task-statuses` → **Todo** (category: `todo`) and **In Progress** (category: `in_progress`)
3. `POST /api/projects` → project **E2E** (key `E2E`)
4. `POST /api/issues` × 2 → two issues seeded in the Todo status

The workspace slug, status IDs, and drag-target issue ID are written to
`e2e/.e2e-ctx.json` (gitignored) for the spec to read.

### Global teardown (`e2e/global-teardown.ts`)

Removes `e2e/.e2e-ctx.json`.  The test workspace itself is left on the deployment
(no delete-workspace API endpoint exists); old `e2e-*` workspaces can be cleaned
up manually via the API if needed.

### Test: Desktop drag (`board.spec.ts` — `desktop` project)

1. Navigates to `/issues`, injects the test workspace slug + board view into
   `localStorage`, reloads.
2. Arms a `page.waitForRequest` listener for `PATCH /api/issues/<id>`.
3. `dragTo` the first card from the **Todo column** to the **In Progress column**.
4. Asserts:
   - A `PATCH` was fired with `statusId = inProgressStatusId`.
   - The card appears in the In Progress column (optimistic update).
   - The card is no longer in the Todo column.

### Test: Mobile columns stacked (`mobile` project, viewport 375×812)

Asserts that `.board-columns` has computed `flex-direction: column`, which is
applied by the `@media(max-width:640px)` rule in `MOBILE_CSS` (IssueList.tsx).

### Test: Mobile drag suppressed (`mobile` project, viewport 375×812)

The `onDragStart` handler in IssueList.tsx calls `e.preventDefault()` when
`window.innerWidth < 640`.  This test:

1. Monitors `PATCH /api/issues/**` requests via `page.route`.
2. Performs `dragTo` on a card.
3. Asserts the Todo column still has all its cards (nothing moved).
4. Asserts `patches.length === 0` (no PATCH was fired).

---

## What was executed vs. what needs a live run

| Check | Status |
|---|---|
| `pnpm lint` (Biome) | ✅ Run against this codebase |
| `pnpm --filter @projektor/web type-check` (astro check) | ✅ Run — e2e/ is outside `src/` so not processed |
| `playwright test --list` (config parse) | ✅ Run after `pnpm install` |
| Actual browser tests (drag, PATCH, mobile layout) | ⏳ **Requires** `E2E_BASE_URL` pointing at a live dev deployment |

---

## Architecture notes

- **Isolation**: each run creates its own `e2e-<timestamp>` workspace.  Tests set
  `localStorage["workspace-slug"]` so the island queries that workspace, not production.
- **No production data touched**: the suite never reads from or writes to the default
  `projektor` workspace.
- **No hardcoded ports**: `E2E_BASE_URL` is the single source of truth for all
  API and page navigation URLs.
- **Mobile guard tested indirectly**: the spec verifies `window.innerWidth < 640` and
  that no `PATCH` fires, matching the code's `window.innerWidth < 640` guard in
  `onDragStart` / `onDrop`.
