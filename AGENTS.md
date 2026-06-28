# AGENTS.md

Guidance for AI agents (and humans) working **on** the projektor codebase.
Read this before making changes — it captures conventions that aren't obvious from the code alone.

> Portable source of truth across agent tools (Claude Code, Codex, Cursor, …). `CLAUDE.md` points here.

## What projektor is

A project management tool deployed on Cloudflare. Bringing together AI native design and tried and tested principles.

Design principles

1. Fast and lightweight.
2. Serverless using cloudflare resources.

Implementation details:

- When implementing features or fixing bugs you must always implement a test or tests to confirm the functionality is implemented.
- **Runtime:** Hono on Cloudflare Workers
- **Data:** D1 (SQLite) for relational data, KV for sessions/caches, R2 for file attachments
- **Schema:** Drizzle (migration + schema source of truth) — but query execution is raw `DB.prepare(...)`
- **Monorepo:** pnpm workspaces + turbo. `apps/api` (the Worker), `apps/web` (Astro + Preact static site, served in production via CF Workers Static Assets — see below), `packages/*` (db, types, plugin-sdk), `plugins/*`
- **Deploy:** projektor publishes a self-contained **release artifact** on each `v*` tag; a config-only deploy repo (e.g. `projektor-workspace`) downloads it and ships it with `wrangler` — no submodule, no source checkout downstream. The Worker (`apps/api`) and the built frontend (`apps/web/dist`) ship together: `wrangler.toml` declares an `[assets]` binding with `run_worker_first = ["/api/*", "/mcp/*"]`, so `/api/*` and `/mcp/*` always hit the Hono Worker while every other path serves the static Astro output (per-route HTML, asset-first). The release build compiles `apps/web` and bundles the Worker into a single `worker.js`.

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

### The security invariant: always scope by workspace
Every query MUST be scoped by `workspace_id` (directly, or via a parent entity that was itself workspace-checked — e.g. comments verify their issue belongs to the workspace first). A missing scope is a cross-tenant data leak. This is the single most important correctness rule in the codebase.

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
- **Login provisioning** (`services/provisioning.ts`): runs on every CF Access / dev-bypass login (not the token path). Cloudflare Access is the gate; config decides what a user gets inside — `ADMIN_EMAILS` → `owner` (first admin login also creates the `DEFAULT_WORKSPACE_SLUG` workspace), everyone else → `AUTO_JOIN_ROLE` (default `viewer`; `none` = invite-only). Idempotent; safe to run per request.
- **Roles** (`owner`/`admin`/`member`/`viewer`) are enforced in services via `ctx.role`. Mutations generally block `viewer`; destructive ops may require `owner`.
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

pnpm dev                               # local dev — API on :8787, web on :4321
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

**Before opening a PR:** `pnpm turbo type-check` and `pnpm --filter @projektor/api test` must both be green. CI runs exactly these.

## Git hooks (lefthook)

`pnpm install` runs `prepare`, which calls `lefthook install` and wires two hooks:

- **pre-commit** — `pnpm turbo type-check` (fast; leverages turbo's cache, near-instant on unchanged packages).
- **pre-push** — `pnpm --filter @projektor/api test` (the ~8s vitest suite; too slow for every commit but catches the failures that most often break CI).

These mirror CI (`.github/workflows/ci.yml`) exactly. New contributors get them automatically after `pnpm install`.

**Bypass for WIP commits/pushes:** pass `--no-verify` (or `-n`) to git:

```bash
git commit --no-verify -m "wip: …"
git push --no-verify
```

Agent workers should also use `--no-verify` for intermediate commits; run the full checks before opening a PR. To manually re-run a hook without committing: `pnpm lefthook run pre-push`.

## Fleet coordination protocol

Agents working in parallel on this repo use three coordination primitives. Use them in order.

### 1. Register on start

Call `register_agent` at the top of every session. Link to the issue you are implementing.

```json
{ "name": "wt/my-feature", "issueId": "<issue-uuid>", "kind": "agent" }
```

Save the returned `id` — you'll need it for heartbeats and messages.

### 2. Claim files before touching them

Before editing any file, call `claim_files`. If a claim is already held by another issue, back off and coordinate rather than using `force`.

```json
{ "issueId": "<issue-uuid>", "agentId": "<session-id>", "paths": ["apps/api/src/services/foo.ts", ...] }
```

Check `list_file_claims` (filter by path) to see who holds a file before starting work.

### 3. Post messages to coordinate

Post to the **issue channel** when you start, when you discover a blocker, and when you finish. Post to the **workspace channel** for fleet-wide announcements (e.g. "I'm rebasing mcp.ts, hold off on that file").

```json
{ "scope": "issue:<uuid>", "agentId": "<session-id>", "body": "Starting work on X. Claiming foo.ts." }
{ "scope": "workspace", "agentId": "<session-id>", "body": "Merging routes/mcp.ts in ~2 min." }
```

Poll `list_messages` with a `cursor` to receive messages posted since your last check.

### 4. Heartbeat every ~60 s

Sessions time out after 120 s without a heartbeat. Keep alive while working:

```json
{ "id": "<session-id>" }
```

### 5. Release and end on finish

```json
// release only your issue's claims
{ "paths": ["apps/api/src/services/foo.ts", ...], "issueId": "<issue-uuid>" }
// end the session
{ "id": "<session-id>" }
```

---

## Working in parallel (multi-agent)

This repo is built out via parallel workers in separate git worktrees. To avoid conflicts:
- Give each worker a **disjoint file set** (one domain = its 4-5 files above). Domains don't share files *except* read-only shared scaffolding (`services/types.ts`, `services/errors.ts`, `schemas/common.ts`, the adapters) and `routes/mcp.ts`/`index.ts`.
- **Never let two parallel workers edit `routes/mcp.ts`, `index.ts`, or `test/mcp.test.ts`** — serialize those, or assign to exactly one worker.
- Large refactors that touch shared files go in a **foundation phase first** (behavior-preserving), then fan out per-domain.

### Spawn prompt requirement

Workers will not use the coordination primitives unless explicitly told to. Every spawn prompt for a parallel worker **must** include a `## Coordination` section:

```
## Coordination (required)
You are working in a parallel fleet. Use the projektor MCP to coordinate:

1. `register_agent` at session start — link to your issue ID, save the returned `id`.
2. `claim_files` before touching any file — check `list_file_claims` first; back off if another agent holds a file.
3. `post_message` to `scope: "issue:<uuid>"` when you start, hit a blocker, and finish. Use `scope: "workspace"` for fleet-wide announcements (e.g. "rebasing mcp.ts, hold off").
4. `heartbeat_agent` every ~60 s while working (sessions time out after 120 s of silence).
5. `release_files` then `end_agent` when done.
```

See `~/.claude/docs/spawning-sessions.md` for the full prompt template (Coordination + Finish line are both required sections).

### Fleet planning rules (for the `/fleet` skill and human planners)

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
| sprints | `services/sprints.ts` | `schemas/sprints.ts` | `routes/sprints.ts` | `mcp/sprints.ts` | `test/sprints.test.ts` |
| comments | `services/comments.ts` | `schemas/comments.ts` | `routes/comments.ts` | `mcp/comments.ts` | `test/comments.test.ts` |
| task-types | `services/task-types.ts` | `schemas/task-types.ts` | `routes/task-types.ts` | `mcp/task-types.ts` | `test/task-types.test.ts` |
| custom-fields | `services/custom-fields.ts` | `schemas/custom-fields.ts` | `routes/custom-fields.ts` | `mcp/custom-fields.ts` | `test/custom-fields.test.ts` |

Frontend islands are **not** domain-locked in the same way, but two agents must never
own the same island file. Assign each island to exactly one agent per batch.

**Deploy:** tag a release (`git tag vX.Y.Z && git push --tags`) — `release.yml`
builds the artifact and the config-only deploy repo (`projektor-workspace`) picks
it up. See [docs/deploying.md](./docs/deploying.md).

**CI commands** (must both pass before opening a PR):
```bash
pnpm turbo type-check
pnpm --filter @projektor/api test
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
See **[`docs/mcp-tools.generated.md`](./docs/mcp-tools.generated.md)** (produced by
`apps/api/scripts/gen-mcp-catalog.ts` from `apps/api/src/mcp/*.ts`; CI fails if it is
stale). The grouping there separates **Coordination** tools (the agent-native primitives
used by the fleet protocol above) from **Project data** tools.

**Tip:** `get_issue` accepts `ref: "PROJ-42"` (project key + number) — you don't need the UUID when you have the display key.
