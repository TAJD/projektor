# Playwright E2E

End-to-end tests for the web app (board, issues, wiki, sprints, groups, sharing,
settings and mobile layouts; one `*.spec.ts` per area). They target a **deployed
dev instance**, not a local dev server, and don't run in CI.

> **Known stale (checked 2026-11-11, not run):** because the suite is outside CI, parts
> of it have fallen behind the app. `board.spec.ts` asserts on a `.board-columns`
> element that no longer exists (the board is now
> `src/islands/issue-list/BoardView.tsx`, which stacks columns with a `max-sm:flex-col`
> utility class), and several specs set `localStorage["workspace-slug"]`, which the app
> no longer reads. Expect failures in those tests until the specs are updated against a
> live deployment.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Node ≥ 22.12 | Repo engine requirement (`package.json`) |
| Playwright browsers | `pnpm --filter @projektor/web exec playwright install --with-deps chromium webkit` |
| Dev deployment | `ENVIRONMENT=development`, `DEV_USER_EMAIL` set on the Worker |

### Why a deployed dev instance?

The suite is written against a real deployment: one origin serving the built frontend
and the Worker, with the production routing (static assets first, trailing-slash page
URLs) that the local dev server does not reproduce. Locally the Astro dev server on
`:4321` proxies `/api`, `/mcp` and `/auth` to the API on `:8787`, so the app itself
works there, but the specs have not been run that way. Use a separate dev deployment
of your own; the repo's `apps/api/wrangler.toml` defines no `dev` environment.

### Server-side dev bypass

Auth is handled transparently: when `ENVIRONMENT=development` and `DEV_USER_EMAIL`
are set on the deployment, the API auto-authenticates every request as that user.
If the deployment sits behind Cloudflare Access, or you want requests to carry an API
token, set the optional variables in the table below; `playwright.config.ts` adds them
as headers on every browser request.

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
pnpm --filter @projektor/web exec playwright test --project=mobile-webkit

# Show the HTML report:
pnpm --filter @projektor/web exec playwright show-report
```

---

## Long-running tests (`@long`)

`editor-freeze.spec.ts` (PROJ-310) drives sustained, bursty typing into the
wiki page editor and the issue description editor to catch "editor freeze"
regressions (PROJ-305/306) that only reproduce in a real browser under
realistic timing — not in unit tests. Each test runs for several minutes by
design, so it's excluded from the default `test:e2e` script and run
separately:

```bash
export E2E_BASE_URL=https://your-dev-instance.workers.dev
pnpm --filter @projektor/web test:e2e:long
```

Tests tagged `@long` in their title are excluded from `test:e2e`
(`--grep-invert @long`) and included in `test:e2e:long` (`--grep @long`).
Follow this convention for any future long-running test: put `@long`
literally in the test title.

Not run in CI (same reason as the rest of the suite — no live
`E2E_BASE_URL` deployment is available there); run manually or on a
schedule against a dev deployment.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `E2E_BASE_URL` | **Yes** | Root URL of the dev deployment. API must be at `<url>/api/*`. |
| `E2E_MEMBER_EMAIL` | No | Email invited as a `member` into the ephemeral e2e workspace during `globalSetup`. Defaults to `e2e-member-<slug>@example.com`. Required (alongside `E2E_MEMBER_TOKEN`) to run `confinement.spec.ts`. |
| `E2E_MEMBER_TOKEN` | No | A real, workspace-scoped API token owned by `E2E_MEMBER_EMAIL`. Required to run `confinement.spec.ts`. |
| `PUBLIC_WORKSPACE_SLUG` | No | Sent as `X-Workspace-Slug` on every browser request. Defaults to `projektor`. |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | No | A Cloudflare Access service token, sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`. Needed when the deployment is behind Access. |
| `PROJEKTOR_API_TOKEN` | No | Sent as `Authorization: Bearer <token>`. |

`apps/web/.env.example` lists the same variables.

---

## Two-user group-access model (PROJ-313)

`board.spec.ts`, `groups-flow.spec.ts`, and the admin parts of the suite run
entirely as the dev-bypass admin — every unauthenticated request against the
target deployment is auto-authenticated as the workspace owner. `globalSetup`
uses this identity to additionally provision a **group-access fixture**: a
second ("ungranted") project, a member invited into the workspace, a group
that grants the member `member`-role access to the first project only, and
that member added to the group.

Testing *member*-eyes confinement (does the member actually see only the
granted project?) requires authenticating as that member, and dev-bypass
can't do that — it always resolves to the owner. Workspace-scoped API tokens
also can't be auto-minted for the member: minting a token requires already
being authenticated as its owner, and that owner identity isn't available to
`globalSetup`. So `confinement.spec.ts` is **skipped unless `E2E_BASE_URL`,
`E2E_MEMBER_EMAIL`, and `E2E_MEMBER_TOKEN` are all set** — the member token
must be minted out-of-band (e.g. by logging in as `E2E_MEMBER_EMAIL` once and
creating a workspace API token) and passed in via env.

---

## What the tests do

### Global setup (`e2e/global-setup.ts`)

Runs **once** before any test worker.  Creates a fresh, isolated workspace on the
deployment:

1. `POST /api/workspaces` → workspace slug `e2e-<timestamp>`
2. `POST /api/task-statuses` → **Todo** (category: `todo`) and **In Progress** (category: `in_progress`)
3. `POST /api/projects` → project **E2E** (key `E2E`)
4. `POST /api/issues` × 2 → two issues seeded in the Todo status
5. `POST /api/projects` → project **E2E Ungranted** (key `E2EU`), granted to nobody
6. `POST /api/workspaces/<slug>/members` → invites `E2E_MEMBER_EMAIL` (or a
   generated default) as a `member`
7. `POST /api/workspaces/<slug>/groups` → group **E2E Access Group**
8. `PUT .../groups/<id>/grants` → grants the group `member` role on the E2E project only
9. `POST .../groups/<id>/members` → adds the invited member to the group

The workspace slug, status IDs, drag-target issue ID, both project IDs/keys,
the group ID/name, and the member's email/userId are written to
`e2e/.e2e-ctx.json` (gitignored) for specs to read.

### Global teardown (`e2e/global-teardown.ts`)

Removes `e2e/.e2e-ctx.json`.  The test workspace itself is left on the deployment
(teardown does not delete it); clean up old `e2e-*` workspaces with
`DELETE /api/workspaces/<slug>` after removing their projects.

### Test: Desktop drag (`board.spec.ts` - `desktop` project)

1. Navigates to `/issues`, injects the test workspace slug + board view into
   `localStorage`, reloads.
2. Arms a `page.waitForRequest` listener for `PATCH /api/issues/<id>`.
3. `dragTo` the first card from the **Todo column** to the **In Progress column**.
4. Asserts:
   - A `PATCH` was fired with `statusId = inProgressStatusId`.
   - The card appears in the In Progress column (optimistic update).
   - The card is no longer in the Todo column.

### Test: Mobile columns stacked (`mobile` project, viewport 375×812)

Asserts that `.board-columns` has computed `flex-direction: column`. That class no
longer exists (see the note at the top); the columns container in `BoardView.tsx` now
stacks through `max-sm:flex-col`.

### Test: Mobile drag suppressed (`mobile` project, viewport 375×812)

The `onDragStart` handler in `src/islands/issue-list/BoardView.tsx` calls `e.preventDefault()` when
`window.innerWidth < 640`.  This test:

1. Monitors `PATCH /api/issues/**` requests via `page.route`.
2. Performs `dragTo` on a card.
3. Asserts the Todo column still has all its cards (nothing moved).
4. Asserts `patches.length === 0` (no PATCH was fired).

### `mobile-webkit` project (real WebKit engine)

Runs the same specs as `mobile`, but on Playwright's WebKit browser (via
`devices["iPhone 13"]`) instead of Chromium's mobile emulation. This catches
iOS Safari engine-level quirks — visual-viewport/keyboard resize behavior,
`position: fixed` under scroll, etc. — that Chromium's "mobile" project
can't reproduce, since it's still Chromium under the hood.

Note this is still not a substitute for testing on real Mobile Safari/iOS:
Playwright's WebKit is the same rendering engine but doesn't run inside
actual iOS or Mobile Safari's chrome, so OS-level behavior (Safari toolbar
collapse, PWA install prompts, Add-to-Home-Screen) isn't covered.

### Test: Groups flow — admin (`groups-flow.spec.ts`)

API-driven, using Playwright's `request` fixture (inherits the admin headers
from `playwright.config.ts`):

1. Reads back the seeded group and asserts its grant covers the granted
   project with role `member`, and the invited member is in its member list.
2. Creates a new group, grants it a project, reads the group back, and
   asserts the grant persisted (full create → grant → verify loop).
3. One `page`-based test navigates to `/settings/groups` (the deployment's
   **default** workspace, not the ephemeral one) and asserts the page
   renders — a render smoke of the group-manager surface.

### Test: Group-access confinement — member (`confinement.spec.ts`)

Env-gated (see "Two-user group-access model" above). Builds a dedicated
member-scoped `APIRequestContext` and asserts:

1. `GET /api/projects` includes the granted project and excludes the
   ungranted one.
2. `GET /api/projects/<ungrantedProjectId>` returns `404` (existence is
   hidden from members without a grant).

---

### Test: Link preview cards (`link-cards.spec.ts`, PROJ-1036/1037)

Uses only internal links, so it never depends on a third-party site.

1. A bare issue URL on its own line in an issue body renders as a card showing the
   target's ref and title.
2. A wiki URL with a `#fragment` renders a card naming that section.
3. Pasting an issue URL into the comment editor shows the **Card | Link** popover;
   **Link** rewrites it to `[title](url)`, and the posted comment shows an inline link,
   not a card.

## What was executed vs. what needs a live run

| Check | Status |
|---|---|
| `pnpm lint` (Biome) | ✅ Run against this codebase |
| `pnpm --filter @projektor/web type-check` (astro check) | ✅ Run - e2e/ is outside `src/` so not processed |
| `playwright test --list` (config parse) | ✅ Run after `pnpm install` |
| Actual browser tests (drag, PATCH, mobile layout) | ⏳ **Requires** `E2E_BASE_URL` pointing at a live dev deployment |

---

## Architecture notes

- **Isolation**: each run creates its own `e2e-<timestamp>` workspace. The specs select it
  by setting `localStorage["workspace-slug"]`, which the app no longer reads, so do not
  rely on this isolation: point `E2E_BASE_URL` only at a deployment whose data you can
  afford to change.
- **No hardcoded ports**: `E2E_BASE_URL` is the single source of truth for all
  API and page navigation URLs.
- **Mobile guard tested indirectly**: the spec verifies `window.innerWidth < 640` and
  that no `PATCH` fires, matching the code's `window.innerWidth < 640` guard in
  `onDragStart` / `onDrop`.
