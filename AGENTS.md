# AGENTS.md

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
- **Deploy:** projektor publishes a self-contained **release artifact** on each `v*` tag; a config-only deploy repo (e.g. `projektor-deploy-example`) downloads it and ships it with `wrangler` — no submodule, no source checkout downstream. The Worker (`apps/api`) and the built frontend (`apps/web/dist`) ship together: `wrangler.toml` declares an `[assets]` binding with `run_worker_first = ["/api/*", "/mcp/*", "/wiki", "/.well-known/*"]`, so those paths always hit the Hono Worker while every other path serves the static Astro output (per-route HTML, asset-first). The release build compiles `apps/web` and bundles the Worker into a single `worker.js`.

## Coordination model (read this first)

Projektor expects multiple agents to work the same workspace concurrently. Before
editing anything:

- **Claim before editing.** File claims (`claim_files`) are path-level — they stop two
  agents editing the same files. Matching is **exact string equality**, not globs:
  claiming `src/` reserves nothing under `src/`, so name concrete paths and name them the
  same way the rest of the fleet does. Issue leases (`claim_issue`) are work-item-level —
  they stop two agents picking up the same ticket. The two are independent; you need both.
- **Your session goes stale if it goes quiet.** Liveness is heartbeat-based:
  `SESSION_TTL_SECONDS` in `apps/api/src/services/agent-identity.ts` is **120 seconds**. Any call made with your
  session id (`claim_issue`, `claim_files`, `update_issue`, `post_message`) refreshes it,
  so use the two-call path below and you will rarely need an explicit `heartbeat_agent`.
  Go quiet for two minutes with no such call and your session goes stale: you must
  heartbeat again before you can claim.
- **Both tiers self-heal.** An issue lease or file claim held by a stale session is
  reclaimed by the next claimer in the same call (`release_reason: "expired"`). Still call
  `release_files` and `end_agent` when you finish: reclaim only happens when someone else
  wants the path, so until then your claims sit there looking held, and a clean exit is
  what distinguishes you from a crash in the health data. A file claim with no `agent_id` has
  no heartbeat to judge, so it lapses by age instead: `FILE_CLAIM_TTL_SECONDS` (default 24h,
  PROJ-928), after which the next claimer reclaims it; before that, only `force` gets past it.
- **There's a per-project cap on concurrently leased issues** —
  `DEFAULT_AGENT_WIP_LIMIT = 3` in `apps/api/src/services/issue-leases.ts`,
  overridable per project via `projects.agent_wip_limit`. It's admission control on
  the backlog, not a rate limit: it bounds how much work can be in flight at once,
  not how fast you can ask.
- **A refused claim tells you who to talk to.** Rejection is all-or-nothing: nothing is
  claimed, and the error names the issue and agent holding the path — message them with
  `post_message` if you need it. Nothing is pushed to the holder on a plain rejection —
  its claim didn't change. `force` is different: it posts to both your issue scope (audit)
  and theirs (PROJ-635), since you just took something they thought they still held. Every
  contended path is recorded regardless.

This is the mechanism; the mechanical call sequence for this repo is under "Fleet
coordination protocol" below, and the design rationale (why leases, claims, and the
WIP cap are shaped this way) is the [coordination model](https://tajd.github.io/projektor/philosophy/coordination-model/)
doc. The workflow rules themselves (definition of ready, state machine, human review
gates) live in exactly one place, the [workflow spec](https://tajd.github.io/projektor/agents/workflow-spec/)
— call `get_workflow` before claiming work; they aren't restated here.

## Planning and design docs live in the wiki, not the repo

Design records, implementation plans, and specs belong in the projektor wiki (`create_wiki_page`/`update_wiki_page`), not in a repo `docs/` folder. Keeping them in the wiki makes them discoverable and searchable (`search_wiki`) instead of buried in git history. The only docs that belong in the repo are the root-level files (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `llms.txt`) and the public docs site (`apps/docs`).

## Human-authored files

Most docs may be generated or written by agents, but these paths are human-authored (Tom's decision, PROJ-915):

- `README.md`
- `apps/docs/src/content/docs/philosophy/**`

Agents must not edit these files, not even to fix a typo or a stale fact. When your work makes one of them inaccurate, add a comment to the current editorial issue (PROJ-914 or its successor) that quotes the affected line and states the fact that changed. Docs checks may still scan these files and report drift, but the fix goes to the editorial issue, never into an agent's diff. `.github/CODEOWNERS` requires @TAJD's review on both paths.

## Architecture: the service-layer contract (most important)

There are **two surfaces** over the same data — a REST API and an MCP (JSON-RPC) server.
They MUST behave identically. The mechanism that guarantees this:

```
                              ┌─► routes/<domain>.ts  (REST: operationsRouter(...))
operations/<domain>.ts  ──────┤
(one defineOperation per op)  └─► mcp/<domain>.ts     (MCP:  ops.map(toMcpTool))
        │ run(ctx, input)
        ▼
services/<domain>.ts  ─►  D1     (ALL business logic + SQL live here)
```

**Rules:**
1. **Each operation is declared once** in `operations/<domain>.ts` with `defineOperation` (id, method + path, tier/role, input schema, `run` → service call, optional `mcpResult` shaping). `routes/<domain>.ts` and `mcp/<domain>.ts` are one-line adapters over that list (`operations/define.ts`); the OpenAPI spec and tool catalog are generated from it too (PROJ-895).
2. **All business logic and SQL live in `services/<domain>.ts`.** No SQL in `operations/`, `routes/` or `mcp/`.
3. **REST and MCP must stay at parity.** Add or change behavior in the service and operation so *both* surfaces get it. Adding a feature to only one surface is a bug; `mcp-parity.node.test.ts` fails on drift.
4. **Validation uses one shared Zod schema** in `schemas/<domain>.ts` (the operation's `input`, re-checked in the service) — so REST and MCP are validated identically. Never trust raw `unknown` input in a wrapper.
5. **Services throw typed errors** from `services/errors.ts` (`ValidationError`, `NotFoundError`, `ForbiddenError`, `ConflictError`). The wrappers translate them:
   - REST: `http/error-adapter.ts` → HTTP status (400/404/403/409)
   - MCP: `mcp/error-adapter.ts` → a tool result with `isError: true` and `{error: {code, message, fields?, hint?, details?}}` (PROJ-893; `code` is the service error kind). JSON-RPC `error` is only for protocol faults and unexpected internal errors. Never return raw `String(err)` to clients.
6. **Context** is a `ServiceCtx` (`services/types.ts`): `{ db, kv, r2, workspaceId, userId, role? }`. Build it with `ctxFromHono(c)` in REST; the MCP dispatch (`routes/mcp.ts`) builds the equivalent and passes `role` through `PluginContext`.

### Deliberate REST↔MCP parity exceptions

These are REST-only on purpose; don't re-flag them in audits. The enforced list, with a
reason per entry, is `REST_ONLY` in `apps/api/src/test/mcp-parity.node.test.ts`.

| REST-only | Why |
|-----------|-----|
| File upload/download (`POST /api/files`, `GET /api/files/:id`), link card image, wiki export zip | Binary bodies can't cross JSON-RPC. Attachment metadata, link previews and wiki pages are on MCP. |
| Auth login, API token and workspace token minting/revocation, connector grants (`/api/workspaces/:slug/connectors`) | Credential operations stay off the surface agents use; a connector must not list or revoke credentials. |
| OAuth consent (`/oauth/authorize`) | A human approves a grant; an agent is only ever its subject. |
| `GET /api/workspaces/:slug/mcp-info` | Bootstraps the MCP connection itself. |
| Cross-workspace `GET /api/projects` | An MCP connection is bound to one workspace; use `list_projects`. |
| Public sharing (`/api/issues/:id/share`, `/api/share/:token`), public feedback submit (`/api/feedback/submit`) | Browser or anonymous end-user flows with no user/role for a tool to act as. |
| Feedback bulk triage and summary dashboard, workspace logo upload/delete | Human UI actions (PROJ-634); single-item feedback triage is on MCP. |

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

**Releasing:** run the `release-prepare.yml` workflow (patch/minor/major); it opens a
`release`-labelled version-bump PR. Merging it fires `release-tag.yml`, which tags `vX.Y.Z`
and triggers `release.yml` to build the artifact that the config-only deploy repo
(`projektor-deploy-example`) ships. Don't tag by hand. See the
[deploy guide](https://tajd.github.io/projektor/guides/deploying/).

## File layout per domain

When adding/changing a domain (issues, projects, wiki, comments, …):

| File | Role |
|------|------|
| `apps/api/src/services/<domain>.ts` | business logic, SQL, validation, typed errors |
| `apps/api/src/schemas/<domain>.ts` | Zod schemas (single source of truth; shared primitives in `schemas/common.ts`) |
| `apps/api/src/operations/<domain>.ts` | operation definitions: path, role, input schema, service call, MCP result shape |
| `apps/api/src/routes/<domain>.ts` | REST adapter over the operations (mounted in `index.ts`) |
| `apps/api/src/mcp/<domain>.ts` | MCP adapter over the operations (composed in `routes/mcp.ts`) |
| `apps/api/src/test/<domain>.test.ts` | **domain tests go here** |

**Test convention (don't skip this):** put a domain's tests in its own `<domain>.test.ts`. Do **not** pile MCP tests into the shared `test/mcp.test.ts` — parallel work on multiple domains will collide there on merge. (`mcp.test.ts` is for cross-cutting dispatch behavior only.)

## Conventions & gotchas

- **Adding a migration?** After adding a new `.sql` file to `packages/db/migrations/`, you must also add a corresponding `?raw` import to `apps/api/src/test/migrations.ts` and append it to the `MIGRATIONS` array. Without this the test DB won't have the new table and integration tests will silently fail or error. Migrations are **hand-written SQL** — drizzle-kit's generator is deliberately not wired up (PROJ-643): its journal was abandoned after `0001`, so `drizzle-kit generate` diffed against a snapshot ~52 migrations stale and emitted a full `CREATE TABLE` for every table, which would fail against any non-empty database. Don't re-add it without re-baselining the snapshot first. A migration that adds an index ends with `PRAGMA optimize;` so the planner has fresh statistics (PROJ-857).
- **Deletes never rely on FK cascades.** Deleting a row that other tables reference must remove (or null) those rows explicitly in the service, in the same `db.batch()` - `ON DELETE CASCADE/SET NULL` in the schema is not the cleanup (PROJ-407/918), and FTS mirrors, R2 objects and non-FK references have no cascade at all. Adding an FK with `ON DELETE` means adding the cleanup and an entry in `apps/api/src/test/architecture/fk-cleanup-allowlist.ts`; `fk-cleanup.node.test.ts` fails otherwise. (`PRAGMA foreign_keys = OFF` is a no-op on D1/Miniflare, so tests can't switch cascades off to prove cleanup.)
- **Issue search mirrors are written in the same batch as the issue.** `issues_fts` is keyed by `issues.search_rowid` (never delete it by the UNINDEXED `issue_id`), and `issue_labels` mirrors `issues.labels`, the table label search and filters read. A new path that writes title, body or labels must reuse `buildFtsReindexStatements` / `buildLabelIndexStatements` in `services/issues.ts`; a path that deletes issues must also delete their rows from both tables.
- **camelCase at the boundary, snake_case in the DB.** Input schemas use `assigneeId`, `parentId`, etc.; the service maps to the `assignee_id` column. Keep both surfaces on the same naming.
- **JSON columns** (`labels`, `scopes`) are stored via `JSON.stringify` and returned as raw JSON strings — callers `JSON.parse` on read. There is no automatic (de)serialization.
- **Timestamps** are unix seconds: `Math.floor(Date.now() / 1000)`.
- **IDs** are `crypto.randomUUID()`.
- **Issue numbers** use `COALESCE(MAX(number),0)+1` per project — known race under concurrency (tracked as a follow-up).
- **Auth** (`middleware/auth.ts`): Cloudflare Access JWT (browser) OR `Authorization: Bearer <token>` (agents) OR a dev bypass (`DEV_USER_EMAIL`, non-prod only, and never on `/mcp/` — a remote MCP client learns it must authenticate from the 401 challenge, so answering 200 makes the connector flow unreachable). API tokens are workspace-scoped — don't widen that.
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

## Frontend: project identity (`apps/web/src/lib/project-context.ts`)

Islands are separate `client:load` roots (each its own Preact tree), so Preact context can't
cross between them. Project identity instead lives in a module-level `@preact/signals` store:
`currentProject`, `projectsList`, `projectError`, `projectReady`. Module state survives Astro's
`ClientRouter` navigations, so whichever island resolves first writes it and every sibling
island, plus the next in-app navigation, reads it without a refetch.

Islands call `ensureProjectResolved(workspaceSlug, urlHint?, matches?)` (or the `useCurrentProject`
hook) instead of parsing `?projectId=`/`?id=` or fetching `/api/projects` themselves. Resolution
persists the resolved id back to the address bar via `history.replaceState` (see
`resolve-project-id.ts`'s `persistProjectId`), so copied URLs stay shareable. This is the only
`@preact/signals` usage in the codebase and the only module-level store pattern for cross-island
state — reach for it, don't invent a second one, before adding a new island that needs project
identity.

The identity param is a boundary concern, not a transport mechanism: links between pages that
stay within the resolved project (`ProjectNav`'s tabs, in-app links to a project's own issues,
wiki pages, etc.) carry no project param at all — the store survives the `ClientRouter`
navigation those `<a>` tags trigger, so the destination resolves instantly with no refetch.
`?projectId=` (the project UUID) is written only where identity actually crosses a boundary: the
cold-start entry point (`ProjectList`'s project cards), a full non-SPA reload
(`window.location.href` assignments, which drop all in-memory state), or an explicit project
switch. `?id=` is reserved for a page's own entity (an issue on `/issues/view`, for example) and
is never used for project identity in newly-written links — the resolver still accepts it (along
with `?project=`) on read, for backward compatibility with existing shared URLs.

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

**Before opening a PR**, run what CI runs (`.github/workflows/ci.yml`) — all must be green:

```bash
pnpm gen:docs                              # must leave no diff (catalog, specs, README stats, conventions page)
pnpm lint
pnpm turbo type-check
pnpm --filter @projektor/db test
pnpm --filter @projektor/api test:coverage
pnpm --filter @projektor/web test:coverage
pnpm --filter @projektor/web build && pnpm --filter @projektor/api build && pnpm bundle-budget
pnpm --filter @projektor/docs build
```

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

There is deliberately no `pre-push` hook: CI is the gate (main is PR-protected), and the old hook could report a successful push after its test step failed. Don't re-add one without solving that.

CI runs the full **Before opening a PR** set above; the hook is only a fast subset.

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

### Session identity (PROJ-894)

`register_agent` (and `start_work`) records the credential the call authenticated with on
the session (`agent_sessions.credential_id` + `auth_method`). A lone agent on its own
credential may then omit the agent id on `claim_issue`, `heartbeat_agent` and `end_agent`.
**Fleets that share one credential (one `pk_` token for every worker) should still pass
`agentId` explicitly**: with several live sessions on the credential an omitted id is
ambiguous and is rejected. No per-connection state exists; the session is looked up from the
credential on every call (PROJ-452 statelessness holds).

### The two-call path (PROJ-929)

`start_work` and `finish_work` collapse the sequence below into two calls:

1. `start_work({ issue, paths, name })` at session start — registers the session, claims
   the issue and files (if given), and posts the start message. All-or-nothing with
   compensating cleanup, not a single atomic write (D1 has no cross-call interactive
   transaction): on any conflict (the same `claim_issue`/`claim_files` errors as before)
   the session is ended and nothing is left claimed. If the process crashes mid-call
   (so that cleanup never runs), the claims it made become reclaimable once the
   session's heartbeat goes stale after the 120s TTL, same as any other stale holder.
   Save the returned `sessionId`. When an issue was claimed, the result also carries
   that `issue` (the `get_issue` shape), so no follow-up `get_issue` is needed.
2. `finish_work({ sessionId, issue, completionReport?, status? })` when done — optionally
   transitions the issue via the same path `update_issue` uses (completion-report rules
   apply unchanged), then releases every claim/lease the session holds and ends it.

`claim_issue`/`claim_files`/`update_issue`/`post_message` calls made with a live agent
session id refresh that session's heartbeat as a side effect, and `finish_work` ends the
session outright, so an explicit `heartbeat_agent` is optional on this path — call it
anyway if a lot of work happens between `start_work` and `finish_work` with no other
agent-scoped call in between.

### The five-call path (still supported)

The primitives above compose from these, which remain available for finer-grained
control (e.g. claiming files separately from the issue, or checking `list_file_claims`
before deciding whether to `force`):

1. `register_agent` at session start, linking the issue you're implementing — save the returned `id`.
2. `claim_files` before touching any file (check `list_file_claims` first; back off, don't `force`).
3. `post_message` to `scope: "issue:<uuid>"` when you start/blocker/finish; `scope: "workspace"` for fleet-wide notices.
4. `heartbeat_agent` only if more than ~2 minutes pass between calls that carry your session id (those refresh it already; sessions time out after 120 s of silence).
5. `release_files` then `end_agent` when done.

See the [MCP tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/) for each tool's exact input schema.

---

## Working in parallel (multi-agent)

This repo is built out via parallel workers in separate git worktrees. To avoid conflicts:
- Give each worker a **disjoint file set** (one domain = its 4-5 files above). Domains don't share files *except* read-only shared scaffolding (`services/types.ts`, `services/errors.ts`, `schemas/common.ts`, the adapters) and `routes/mcp.ts`/`index.ts`.
- **Never let two parallel workers edit `routes/mcp.ts`, `index.ts`, or `test/mcp.test.ts`** — serialize those, or assign to exactly one worker.
- Large refactors that touch shared files go in a **foundation phase first** (behavior-preserving), then fan out per-domain.

### Spawn prompt requirement

Workers will not use the coordination primitives unless explicitly told to. Every spawn prompt for a parallel worker **must** include a `## Coordination (required)` section stating the call sequence from "Fleet coordination protocol" above. Default to the two-call `start_work`/`finish_work` path and tell workers not to call `heartbeat_agent`, `register_agent` or `release_*` separately; use the five-call path only when a task needs finer-grained control.

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

**Domain → file ownership** — one agent per domain, no overlap. A domain owns the files named after it in
`services/`, `schemas/`, `operations/`, `routes/`, `mcp/` and `test/` (see "File layout per domain").

Frontend islands are **not** domain-locked in the same way, but two agents must never
own the same island file. Assign each island to exactly one agent per batch.

**CI commands:** see **Before opening a PR** under "Dev workflow".

**Merge ordering rule:** if two agents both touch the same frontend file (e.g.
`IssueList.tsx`), assign one as "primary" and one as "secondary". Primary merges
first; secondary rebases onto main before merging. Document this in the spawn prompts
and in the fleet manifest.

---

## MCP tool catalog

All tools are available via `POST /mcp/<workspaceId>` (JSON-RPC 2.0). Connect with:

```bash
claude mcp add --transport http projektor "https://<host>/mcp/<workspaceId>" \
  --header "Authorization: Bearer pk_<token>"   # name + URL before --header (it's variadic)
```

**The full tool list is generated from source — do not hand-maintain a copy here.**
See the **[MCP tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/)**
(generated into `apps/docs/src/content/docs/agents/tool-catalog.md` by
`apps/api/scripts/gen-mcp-catalog.ts` from the MCP tool registry; CI fails if it is
stale). The grouping there separates **Coordination** tools (the agent-native primitives
used by the fleet protocol above) from **Project data** tools.

**Tip:** `get_issue` accepts `ref: "PROJ-42"` (project key + number) — you don't need the UUID when you have the display key.

**Load only the tools you need (PROJ-1056):** append `?domains=<slug>,…` to the MCP URL, for example `?domains=agents,issues,comments,issue-links,workflow` for an issue-working agent. It filters `tools/list` (the full list is ~93KB of definitions); slugs are shown next to each domain in the tool catalog. `get_tool_usage` reports per-tool calls and response bytes, so you can see what your agents actually spend.
