---
title: "Contributor conventions"
description: "Architecture contract and conventions for working on the Projektor codebase."
sidebar:
  order: 1
---
> **Note:** this page is generated from [`AGENTS.md`](https://github.com/TAJD/projektor/blob/main/AGENTS.md)
> in the repo root by `scripts/gen-conventions-page.ts`. Edit that file, not this page — it is
> overwritten on every generate.

Guidance for AI agents (and humans) working **on** the projektor codebase.
Read this before making changes — it captures conventions that aren't obvious from the code alone.

> Portable source of truth across agent tools (Claude Code, Codex, Cursor, …). `CLAUDE.md` points here.

## What projektor is

A project management tool deployed on Cloudflare, combining AI-native design with tried-and-tested principles.

Design principles

1. Fast and lightweight.
2. Serverless, built on Cloudflare resources.

Implementation details:

- When implementing a feature or fixing a bug, always add a test that confirms the behaviour.
- **Runtime:** Hono on Cloudflare Workers
- **Data:** D1 (SQLite) for relational data, KV for caching (Access certs, user-by-email), R2 for file attachments
- **Schema:** Drizzle is the schema and primary query layer; raw `DB.prepare` remains in the auth/workspace middleware hot path, the dev bootstrap, and a handful of service queries (FTS, counters) where hand-written SQL is clearer.
- **Monorepo:** pnpm workspaces + turbo. `apps/api` (the Worker), `apps/web` (Astro + Preact static site, served in production via CF Workers Static Assets — see below), `apps/docs` (the Astro docs site linked throughout this file), `packages/*` (db, types, plugin-sdk), `plugins/*`
- **Deploy:** projektor publishes a self-contained **release artifact** on each `v*` tag; a config-only deploy repo (e.g. `projektor-deploy-example`) downloads it and ships it with `wrangler` — no submodule, no source checkout downstream. The Worker (`apps/api`) and the built frontend (`apps/web/dist`) ship together: `wrangler.toml` declares an `[assets]` binding with `run_worker_first = ["/api/*", "/mcp/*"]`, so `/api/*` and `/mcp/*` always hit the Hono Worker while every other path serves the static Astro output (per-route HTML, asset-first). The release build compiles `apps/web` and bundles the Worker into a single `worker.js`.

## Coordination model (read this first)

Projektor expects multiple agents to work the same workspace concurrently. Before
editing anything:

- **Claim before editing.** File claims (`claim_files`) are path-level — they stop two
  agents editing the same files. Matching is **exact string equality**, not globs:
  claiming `src/` reserves nothing under `src/`, so name concrete paths and name them the
  same way the rest of the fleet does. Issue leases (`claim_issue`) are work-item-level —
  they stop two agents picking up the same ticket. The two are independent; you need both.
- **Your session goes stale if you stop heartbeating.** Liveness is heartbeat-based:
  `ACTIVE_TTL` in `apps/api/src/services/agents.ts` (mirrored as `SESSION_TTL_SECONDS` in
  `apps/api/src/services/issue-leases.ts`) is **120 seconds**. Register, then go quiet for
  two minutes without a `heartbeat_agent` call, and your session goes stale — you must
  heartbeat again before you can claim.
- **Both tiers self-heal.** An issue lease or file claim held by a stale session is
  reclaimed by the next claimer in the same call (`release_reason: "expired"`). Still call
  `release_files` and `end_agent` when you finish: reclaim only happens when someone else
  wants the path, so until then your claims sit there looking held, and a clean exit is
  what distinguishes you from a crash in the health data. A claim with no `agent_id` has no
  heartbeat to judge and is never auto-reclaimed — `force` is the only way past it.
- **There's a per-project cap on concurrently leased issues** —
  `DEFAULT_AGENT_WIP_LIMIT = 3` in `apps/api/src/services/issue-leases.ts`,
  overridable per project via `projects.agent_wip_limit`. It's admission control on
  the backlog, not a rate limit: it bounds how much work can be in flight at once,
  not how fast you can ask.
- **A refused claim tells you who to talk to.** Rejection is all-or-nothing: nothing is
  claimed, and the error names the issue and agent holding the path — message them with
  `post_message` if you need it. Nothing is pushed to the holder either way, including
  when you use `force` (that posts an audit message to *your* issue scope, not theirs), so
  if you override someone, tell them yourself. Every contended path is recorded regardless.

This is the mechanism; the mechanical call sequence for this repo is under "Fleet
coordination protocol" below, and the design rationale (why leases, claims, and the
WIP cap are shaped this way) is the [coordination model](https://tajd.github.io/projektor/philosophy/coordination-model/)
doc. The workflow rules themselves (definition of ready, state machine, human review
gates) live in exactly one place, the [workflow spec](https://tajd.github.io/projektor/agents/workflow-spec/)
— call `get_workflow` before claiming work; they aren't restated here.

## Planning and design docs live in the wiki, not the repo

Design records, implementation plans, and specs belong in the projektor wiki (`create_wiki_page`/`update_wiki_page`), not in a repo `docs/` folder. Keeping them in the wiki makes them discoverable and searchable (`search_wiki`) instead of buried in git history. Root-level user-facing docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`) are the only docs that belong in the repo itself.

## Architecture: the service-layer contract (most important)

There are **two surfaces** over the same data — a REST API and an MCP (JSON-RPC) server.
They MUST behave identically. The mechanism that guarantees this:

```
routes/<domain>.ts   (REST wrapper)  ─┐
                                       ├─►  services/<domain>.ts   ─►  D1
mcp/<domain>.ts      (MCP wrapper)   ─┘     (ALL business logic + SQL live here)
```

**Rules:**
1. **All business logic and SQL live in `services/<domain>.ts`.** Routes and MCP tools are thin wrappers — resolve context, call the service, adapt the result/error. No SQL in `routes/` or `mcp/`.
2. **REST and MCP must stay at parity.** If you add or change behavior, do it in the service so *both* surfaces get it. Adding a feature to only one surface is a bug.
3. **Validation happens inside the service** via a shared Zod schema in `schemas/<domain>.ts` — so REST and MCP are validated identically. Never trust raw `unknown` input in a wrapper.
4. **Services throw typed errors** from `services/errors.ts` (`ValidationError`, `NotFoundError`, `ForbiddenError`, `ConflictError`). The wrappers translate them:
   - REST: `http/error-adapter.ts` → HTTP status (400/404/403/409)
   - MCP: `mcp/error-adapter.ts` → JSON-RPC code (`-32602` for validation, `-32000` otherwise). Never return raw `String(err)` to clients.
5. **Context** is a `ServiceCtx` (`services/types.ts`): `{ db, kv, r2, workspaceId, userId, role? }`. Build it with `ctxFromHono(c)` in REST; the MCP dispatch (`routes/mcp.ts`) builds the equivalent and passes `role` through `PluginContext`.

### Deliberate REST↔MCP parity exceptions

These surface-only features are intentional, not drift — don't re-flag them in future
audits:

- **File attachment upload/download (`POST /api/files`, `GET /api/files/:id`)** —
  REST-only. Binary/multipart upload and streamed download can't cross JSON-RPC.
  Metadata operations (list, get metadata, link-create, delete) have full MCP parity
  via `mcp/files.ts`.
- **Auth (`routes/auth.ts`): login redirect, API token minting/revocation** — REST-only.
  CF Access login is a browser redirect flow; token minting/revocation is a sensitive
  credential operation kept off the MCP surface.
- **Workspace-scoped API tokens (`POST/GET/DELETE /api/workspaces/:slug/tokens`)** —
  REST-only, same rationale as auth tokens above.
- **`GET /api/workspaces/:slug/mcp-info`** — REST-only. Bootstraps how to connect an MCP
  client in the first place; inherently can't be an MCP tool.
- **Cross-workspace project list (`GET /api/projects` → `listAllProjects`)** — REST-only.
  MCP connections are bound to a single workspace (`/mcp/<workspaceId>`), so a
  cross-workspace listing doesn't fit the MCP connection model. MCP's `list_projects` is
  the single-workspace equivalent (different, plainer shape — no `open_issue_count` /
  `workspace_name` rollups).
- **Public issue sharing (`POST /api/issues/:id/share`, `GET /api/share/:token`)** —
  REST-only. Share-link creation/redemption is a browser-facing feature (the redemption
  endpoint is intentionally unauthenticated by token).
- **`get_prioritized_issues`** — MCP-only. An agent-productivity tool ("what should I
  work on next") with no natural REST/browser analog.
- **Wiki export (`GET /api/wiki/export`)** — REST-only. Returns a binary zip
  (markdown + attachments) which can't cross JSON-RPC the same way file download
  can't (see the file-attachment exception above); import is explicitly out of
  scope (PROJ-497) so there's no round-trip MCP surface to keep parity with either.
- **Public feedback submission (`POST /api/feedback/submit`)** — REST-only.
  Anonymous end-user feedback from a third-party product, authenticated by a per-source
  bearer token, not a session — there's no ServiceCtx user/role for an MCP tool to act as.
  Feedback *source management* (create/list/update/rotate/revoke) has full REST+MCP
  parity, same as every other admin-facing domain; only the anonymous submit endpoint
  itself is the exception.

### The security invariant: always scope by workspace
Every query MUST be scoped by `workspace_id` (directly, or via a parent entity that was itself workspace-checked — e.g. comments verify their issue belongs to the workspace first). A missing scope is a cross-tenant data leak. This is the single most important correctness rule in the codebase.

### The D1 limit: never bind a row-scaled array into one query
Cloudflare **D1 rejects any query with more than 100 bound parameters.** A query whose parameter count grows with an input array — drizzle `inArray`, a raw `IN (...)`, or a batched mutation keyed by ids — will throw at runtime (a 500) once the array is large enough. **This is invisible in tests:** the vitest runner backs D1 with SQLite (cap 32766), so an un-chunked query passes CI and only fails on real D1.

Route every variable-length `IN`/`inArray` load through **`inChunks` (`services/sql.ts`)**, which splits the array so each query stays under the cap:

```ts
const rows = await inChunks(issueIds, (chunk) =>
  orm.select(...).from(...).where(and(inArray(table.id, chunk), eq(table.workspaceId, ctx.workspaceId)))
);
// for a mutation that returns nothing, have the callback return []
```

Bounded arrays (enums like priority) are fine to bind directly. When in doubt, chunk.

## Versioning

**`apps/web/package.json` is the single version source** for the whole monorepo -
bumped by `release-prepare.yml`, tagged by `release-tag.yml`, and read by
`release.yml`/`scripts/build-release.sh` to produce the release artifact (embedded
as `VERSION` in the tarball and injected into the MCP `serverInfo.version` via
esbuild `--define`). Every other `apps/*`/`packages/*` package's `package.json`
`version` field is a fixed `0.0.0-workspace` placeholder — those packages are
workspace-internal and not independently released, so their version field is unused
and intentionally never bumped. `plugins/*` packages carry their own unused
placeholder versions (e.g. `0.0.0`, `0.0.1`), not `0.0.0-workspace`.

## File layout per domain

When adding/changing a domain (issues, projects, wiki, comments, …):

| File | Role |
|------|------|
| `apps/api/src/services/<domain>.ts` | business logic, SQL, validation, typed errors |
| `apps/api/src/schemas/<domain>.ts` | Zod schemas (single source of truth; shared primitives in `schemas/common.ts`) |
| `apps/api/src/routes/<domain>.ts` | REST wrapper (mounted in `index.ts`) |
| `apps/api/src/mcp/<domain>.ts` | MCP tool array (composed in `routes/mcp.ts`) |
| `apps/api/src/test/<domain>.test.ts` | **domain tests go here** |

**Test convention (don't skip this):** put a domain's tests in its own `<domain>.test.ts`. Do **not** pile MCP tests into the shared `test/mcp.test.ts` — parallel work on multiple domains will collide there on merge. (`mcp.test.ts` is for cross-cutting dispatch behavior only.)

## Conventions & gotchas

- **Adding a migration?** After adding a new `.sql` file to `packages/db/migrations/`, you must also add a corresponding `?raw` import to `apps/api/src/test/migrations.ts` and append it to the `MIGRATIONS` array. Without this the test DB won't have the new table and integration tests will silently fail or error.
- **camelCase at the boundary, snake_case in the DB.** Input schemas use `assigneeId`, `parentId`, etc.; the service maps to the `assignee_id` column. Keep both surfaces on the same naming.
- **JSON columns** (`labels`, `scopes`) are stored via `JSON.stringify` and returned as raw JSON strings — callers `JSON.parse` on read. There is no automatic (de)serialization.
- **Timestamps** are unix seconds: `Math.floor(Date.now() / 1000)`.
- **IDs** are `crypto.randomUUID()`.
- **Issue numbers** use `COALESCE(MAX(number),0)+1` per project — known race under concurrency (tracked as a follow-up).
- **Auth** (`middleware/auth.ts`): Cloudflare Access JWT (browser) OR `Authorization: Bearer <token>` (agents) OR a dev bypass (`DEV_USER_EMAIL`, non-prod only). API tokens are workspace-scoped — don't widen that.
- **Login provisioning** (`services/provisioning.ts`): runs on every CF Access / dev-bypass login (not the token path). Cloudflare Access is the gate; config decides what a user gets inside — `ADMIN_EMAILS` → `owner` (first admin login also creates the `DEFAULT_WORKSPACE_SLUG` workspace), everyone else → `AUTO_JOIN_ROLE` (default `none` = invite-only; set it, e.g. `viewer`, to auto-join). Idempotent; safe to run per request.
- **Roles** (`owner`/`admin`/`member`/`viewer`) are enforced in services via `ctx.role`. Mutations generally block `viewer`; destructive ops may require `owner`.
- **Group-based project access** is the authorization model for project-scoped data. Access is **default-deny**: owner/admin see everything, but everyone else sees a project only if one of their **groups** holds a `(project, role)` grant. The effective in-project role is the strongest grant across the user's groups and *replaces* their workspace role inside that project (so a workspace `viewer` with a `member` grant can write there). Enforce it through `services/access.ts`: `visibleProjectPredicate` (an indexed `EXISTS` subquery — filter every project-scoped **list** query with it), `effectiveProjectRole`/`requireProjectAccess` (resolve a single resource; `null` → 404 to hide existence), and `canWriteProject`. Membership is read per-request, so grant/revoke takes effect on the next request with no session state. The `groups` domain (service/routes/mcp) is owner/admin-only CRUD over groups, members, and grants.
- **The plugin system is not wired at runtime yet** (`pluginRegistry` is empty; `enabled_plugins` is unread). Treat `plugins/*` as not-yet-functional until that lands.

## localStorage policy (frontend)

`localStorage` may only store **cosmetic preferences** (theme, view mode, layout choices).
Never store server-side entity references (workspace slug, project ID, user ID) — a deleted
or renamed entity leaves a stale value that will silently cause API 4xx errors.

**Before adding a new `localStorage.setItem` call, ask:**
1. Does a stale value ever reach an API request? If yes → don't store it; derive it from
   props or build-time env instead.
2. Does a missing value crash the UI or produce a non-graceful error? If yes → add a
   safe fallback, not localStorage.

Mark safe usages with a `// safe-ls:` comment explaining why (cosmetic, no API dep,
degrades gracefully). This is the convention established in PR #99.

## Frontend: islands and the API layer

All island↔API calls go through `apps/web/src/utils/api-client.ts`:
- `buildHeaders(workspaceSlug, extra?)` — adds the X-Workspace-Slug header
- `apiFetch<T>(path, opts)` — wraps fetch with headers, credentials, JSON parse, and error throwing

No raw `fetch(` calls in island components. No local `buildHeaders` copies.
This mirrors the backend service-layer contract: routes are thin wrappers; islands are thin callers.

## Dev workflow

```bash
pnpm install
pnpm turbo type-check                  # tsc --noEmit across the monorepo
pnpm --filter @projektor/api test      # vitest against an in-process Worker + D1

# One-time local secrets so the browser frontend can auth without Cloudflare Access:
cp apps/api/.dev.vars.example apps/api/.dev.vars   # DEV_USER_EMAIL + BOOTSTRAP_SECRET
cp apps/web/.env.example apps/web/.env             # PUBLIC_WORKSPACE_SLUG=projektor

pnpm dev                               # local dev - API on :8787, web on :4321
# `dev` auto-applies D1 migrations to the local Miniflare DB first (db:migrate:local),
# so /api/* won't 500 with "no such table" on a fresh checkout.
```

`GET /bootstrap` (non-prod only, needs `BOOTSTRAP_SECRET`) seeds a workspace + user + token
+ membership in one shot and prints the `claude mcp add ...` command to connect an agent. Seed it once:

```bash
curl -H "X-Bootstrap-Secret: localdev" http://127.0.0.1:8787/bootstrap
```

Then open **http://localhost:4321** — with `DEV_USER_EMAIL` set, the dev auth bypass logs you in
as that user (a member of the seeded `projektor` workspace), and the islands load real data.

**Before opening a PR:** `pnpm lint`, `pnpm turbo type-check`, `pnpm --filter @projektor/db test`, `pnpm --filter @projektor/api test:coverage`, `pnpm --filter @projektor/web test:coverage`, `pnpm --filter @projektor/web build`, and `pnpm --filter @projektor/docs build` must all be green, and `pnpm gen:docs` must produce no diff. CI runs these plus the island API and design system convention checks (`.github/workflows/ci.yml`).

## E2E testing (`apps/web/e2e`, Playwright)

Targets a **deployed dev instance** (`E2E_BASE_URL`), not local dev — see `apps/web/e2e/README.md` for the full setup, fixtures, and per-spec breakdown. Not run in CI (no live deployment there); run manually or on a schedule.

Three projects, pick the narrowest one that answers your question:
- `desktop` — default viewport, Chromium.
- `mobile` — 375×812 viewport via Chromium's mobile emulation. Fast, good for layout/CSS regressions.
- `mobile-webkit` — real WebKit engine (`devices["iPhone 13"]`). Reach for this specifically when investigating iOS Safari engine-level behavior that Chromium can't reproduce (visual-viewport/on-screen-keyboard resize events, `position: fixed` under scroll, etc.) — it caught the PROJ-397/PROJ-566 class of mobile-modal bugs. Still not a substitute for a real device: no Safari chrome, no PWA install/Add-to-Home-Screen coverage.

```bash
pnpm --filter @projektor/web exec playwright test --project=mobile-webkit
```

## Git hooks (lefthook)

`pnpm install` runs `prepare`, which calls `lefthook install` and wires one hook:

- **pre-commit** — `pnpm turbo type-check` (fast; leverages turbo's cache, near-instant on unchanged packages) and `pnpm biome check --changed --no-errors-on-unmatched` (lint, changed files only).

There is deliberately no `pre-push` hook — CI (`.github/workflows/ci.yml`) is the authoritative gate before merge (main is PR-protected; direct pushes are rejected), so a local pre-push copy of the same checks was pure redundant overhead. It was also a source of real bugs: under concurrent local load its test step could fail while a backgrounded `git push` still reported exit code 0, masking a rejected push. It was removed for these reasons; don't re-add one without addressing both.

CI runs a superset of the pre-commit checks: the generated-docs freshness check, `pnpm lint`, `pnpm turbo type-check`, `pnpm --filter @projektor/db test`, coverage-enforced test runs for `@projektor/api` and `@projektor/web`, and both the web and docs builds. New contributors get the pre-commit hook automatically after `pnpm install`. See **Before opening a PR** above for the full local command set to run before pushing.

**Bypass for WIP commits:** pass `--no-verify` (or `-n`) to git:

```bash
git commit --no-verify -m "wip: …"
```

Agent workers should also use `--no-verify` for intermediate commits; run the full checks (listed under "Before opening a PR" above) before opening a PR.

## Fleet coordination protocol

The workflow rules (definition of ready, state machine, human review gates, WIP
limits) have exactly one home: the [workflow spec](https://tajd.github.io/projektor/agents/workflow-spec/),
served live via the `get_workflow` MCP tool / `GET /api/workflow`. Call it before
claiming work — don't rely on a copy of the rules here, they aren't restated in this
file.

What *is* repo-specific and stays here: the mechanical call sequence agents use to
avoid colliding in this particular repo's git worktree/file layout.

1. `register_agent` at session start, linking the issue you're implementing — save the returned `id`.
2. `claim_files` before touching any file (check `list_file_claims` first; back off, don't `force`).
3. `post_message` to `scope: "issue:<uuid>"` when you start/blocker/finish; `scope: "workspace"` for fleet-wide notices.
4. `heartbeat_agent` every ~60 s (sessions time out after 120 s of silence).
5. `release_files` then `end_agent` when done.

See the [MCP tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/) for each tool's exact input schema.

---

## Working in parallel (multi-agent)

This repo is built out via parallel workers in separate git worktrees. To avoid conflicts:
- Give each worker a **disjoint file set** (one domain = its 4-5 files above). Domains don't share files *except* read-only shared scaffolding (`services/types.ts`, `services/errors.ts`, `schemas/common.ts`, the adapters) and `routes/mcp.ts`/`index.ts`.
- **Never let two parallel workers edit `routes/mcp.ts`, `index.ts`, or `test/mcp.test.ts`** — serialize those, or assign to exactly one worker.
- Large refactors that touch shared files go in a **foundation phase first** (behavior-preserving), then fan out per-domain.

### Spawn prompt requirement

Workers will not use the coordination primitives unless explicitly told to. Every spawn prompt for a parallel worker **must** include a `## Coordination (required)` section stating the 5-step sequence from "Fleet coordination protocol" above.

A full spawn prompt also needs a **Finish** section (what "done" means for the task,
and what to report back) alongside the Coordination section above.

### Fleet planning rules

These are the constraints the fleet skill reads to plan batches. Keep them current when the codebase changes.

**Serialized files** — only one worker at a time, ever:

| File | Reason |
|------|--------|
| `apps/api/src/routes/mcp.ts` | MCP tool registry — all domains compose here |
| `apps/api/src/index.ts` | Hono app root — route mounting |
| `apps/api/src/test/mcp.test.ts` | Cross-cutting dispatch tests — domain tests go in `test/<domain>.test.ts` |

**Domain → file ownership** — one agent per row, no overlap:

| Domain | Service | Schema | Routes | MCP | Tests |
|--------|---------|--------|--------|-----|-------|
| issues | `services/issues.ts` | `schemas/issues.ts` | `routes/issues.ts` | `mcp/issues.ts` | `test/issues.test.ts` |
| projects | `services/projects.ts` | `schemas/projects.ts` | `routes/projects.ts` | `mcp/projects.ts` | `test/projects.test.ts` |
| wiki | `services/wiki.ts` | `schemas/wiki.ts` | `routes/wiki.ts` | `mcp/wiki.ts` | `test/wiki.test.ts` |
| files | `services/files.ts` | `schemas/files.ts` | `routes/files.ts` | `mcp/files.ts` | `test/files.test.ts` |
| sprints | `services/sprints.ts` | `schemas/sprints.ts` | `routes/sprints.ts` | `mcp/sprints.ts` | `test/sprints.test.ts` |
| comments | `services/comments.ts` | `schemas/comments.ts` | `routes/comments.ts` | `mcp/comments.ts` | `test/comments.test.ts` |
| task-types | `services/task-types.ts` | `schemas/task-types.ts` | `routes/task-types.ts` | `mcp/task-types.ts` | `test/task-types.test.ts` |
| custom-fields | `services/custom-fields.ts` | `schemas/custom-fields.ts` | `routes/custom-fields.ts` | `mcp/custom-fields.ts` | `test/custom-fields.test.ts` |
| workflow | `services/workflow.ts` | — (no input) | `routes/workflow.ts` | `mcp/workflow.ts` | `test/workflow.test.ts` |
| flow-metrics | `services/flow-metrics.ts` | `schemas/flow-metrics.ts` | `routes/flow-metrics.ts` | `mcp/flow-metrics.ts` | `test/flow-metrics.test.ts` |
| groups | `services/groups.ts` | `schemas/groups.ts` | `routes/groups.ts` | `mcp/groups.ts` | `test/groups.test.ts` |

Frontend islands are **not** domain-locked in the same way, but two agents must never
own the same island file. Assign each island to exactly one agent per batch.

**Deploy:** tag a release (`git tag vX.Y.Z && git push --tags`) — `release.yml`
builds the artifact and the config-only deploy repo (`projektor-deploy-example`) picks
it up. See the [deploy guide](https://tajd.github.io/projektor/guides/deploying/).

**CI commands** (must all pass before opening a PR):
```bash
pnpm gen:docs   # must produce no diff
pnpm lint
pnpm turbo type-check
pnpm --filter @projektor/db test
pnpm --filter @projektor/api test:coverage
pnpm --filter @projektor/web test:coverage
pnpm --filter @projektor/web build
pnpm --filter @projektor/docs build
```

**Merge ordering rule:** if two agents both touch the same frontend file (e.g.
`IssueList.tsx`), assign one as "primary" and one as "secondary". Primary merges
first; secondary rebases onto main before merging. Document this in the spawn prompts
and in the fleet manifest.

---

## MCP tool catalog

All tools are available via `POST /mcp/<workspaceId>` (JSON-RPC 2.0). Connect with:

```bash
claude mcp add projektor --transport http https://<host>/mcp/<workspaceId> \
  --header "Authorization: Bearer <token>"
```

**The full tool list is generated from source — do not hand-maintain a copy here.**
See the **[MCP tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/)**
(generated into `apps/docs/src/content/docs/agents/tool-catalog.md` by
`apps/api/scripts/gen-mcp-catalog.ts` from `apps/api/src/mcp/*.ts`; CI fails if it is
stale). The grouping there separates **Coordination** tools (the agent-native primitives
used by the fleet protocol above) from **Project data** tools.

**Tip:** `get_issue` accepts `ref: "PROJ-42"` (project key + number) — you don't need the UUID when you have the display key.
