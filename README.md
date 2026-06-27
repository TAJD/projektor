# projektor

> A self-hosted Jira + Notion hybrid that runs in a single Cloudflare Worker — no servers, no containers.

Wiki + Jira-style issue tracker built MCP-native, running entirely on Cloudflare's edge.
AI agents are a first-class client: the primary surface is a JSON-RPC 2.0 MCP endpoint, not a browser UI.

## What it is

```
┌─────────────────────────────────────────────────────────────────┐
│  projektor                                [+ New Issue]  [you]  │
├──────────┬──────────────────────────────────────────────────────┤
│ Projects │  PROJ  ·  Backlog   Board   Sprints   Wiki           │
│ ──────── │                                                       │
│ PROJ     │  ● PROJ-7  Fix login redirect          [high] Alice  │
│ BACKEND  │  ○ PROJ-8  Add attachment upload        [med]  —     │
│          │  ○ PROJ-9  Rate limiting for /mcp        [low]  —     │
│ Wiki     │  ✓ PROJ-6  Bootstrap endpoint docs      [low] Alice  │
│ Settings │                                                       │
└──────────┴──────────────────────────────────────────────────────┘
```

- **Projects** — named with short keys (`PROJ`, `BE`, …); issues reference as `PROJ-42`
- **Issues** — Jira-style tickets with status, priority, assignee, labels, parent/child hierarchy, and cross-issue links
- **Wiki** — nested markdown pages with revision history and full-text search
- **MCP server** — AI agents connect directly; every action available to the browser is available to an agent

## Features

- Issues with status, priority, assignee, labels, parent/child hierarchy, and issue links
- Kanban board + list view + sprint planning
- Wiki with nested pages, markdown, full-text search, and revision history
- MCP server — AI-native; Claude Code connects via `claude mcp add`
- File attachments (R2)
- Workspace + project + member management with role-based access (`owner` / `admin` / `member` / `viewer`)
- API tokens for agent access, workspace-scoped
- PWA — installable, offline shell

## Self-hosting in 5 minutes

projektor deploys from a **config-only repo** that downloads a pre-built release
artifact — no source checkout, no submodule, no build step. The fastest path is to
**fork the deploy example** and deploy from there.

You need a Cloudflare account and `wrangler` (`npm i -g wrangler`).

### 1. Fork the deploy example

Fork **[`projektor-deploy-example`](https://github.com/TAJD/projektor-deploy-example)** —
your fork becomes the deploy repo (config only: a `wrangler.toml`, a pinned
`projektor.version`, and a deploy workflow).

```bash
gh repo fork TAJD/projektor-deploy-example --clone
cd projektor-deploy-example
```

> A fork is public. If you'd rather keep your config (Cloudflare resource IDs)
> private, create from the template instead:
> `gh repo create my-projektor-deploy --private --template TAJD/projektor-deploy-example`.

### 2. Provision Cloudflare resources

```bash
wrangler d1 create projektor
wrangler kv namespace create projektor
wrangler r2 bucket create projektor-files
```

### 3. Configure wrangler.toml

Pin a version and run the deploy script once — it downloads the release and
scaffolds `wrangler.toml` from the template:

```bash
echo "v1.0.0" > projektor.version    # a published release tag
./deploy.sh                          # creates wrangler.toml, then asks you to fill it in
```

Fill the `REPLACE_` values — D1 `database_id`, KV `id`, your Cloudflare Access team
domain + audience, and `ADMIN_EMAILS`. The `./vendor/...` paths are artifact-owned;
leave them.

> **Cloudflare Access is required** for browser auth (SSO / Zero Trust). Set up an
> Access application pointing at your Worker URL before deploying.

### 4. Set secrets

On the Worker (set once; persists across deploys):

```bash
wrangler secret put JWT_SECRET   # any long random string — signs API tokens
```

For CI deploys, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo
Actions secrets. **The API token must include D1** — Cloudflare's built-in "Edit
Cloudflare Workers" template omits it, which silently breaks migrations. The exact
token recipe is in the [deploy guide](./docs/deploying.md).

### 5. Deploy

```bash
./deploy.sh    # locally (wrangler OAuth), or
git push       # CI deploys on push to main
```

On first load the Worker auto-provisions a workspace for the first user in
`ADMIN_EMAILS`. Open your Worker URL, log in through Cloudflare Access, and you're
running. To connect an AI agent immediately (dev/staging only), use the bootstrap
endpoint — see [Connect an AI agent](#connect-an-ai-agent) below.

**Full reference** — release contents, the Cloudflare token, push-based automatic
updates, and troubleshooting — is in **[docs/deploying.md](./docs/deploying.md)**.

**Updating later:** bump `projektor.version`, commit, and push — CI deploys it (or
wire push-based auto-updates so new releases deploy themselves).

## Connect an AI agent

projektor exposes a JSON-RPC 2.0 MCP endpoint at `POST /mcp/<workspaceId>`.
Any MCP-compatible agent (Claude Code, custom agents via the Anthropic SDK) can connect.

### Development — one command

```bash
# Provision workspace + user + token in one shot (dev/staging only)
curl -s "https://<your-worker>.workers.dev/bootstrap" \
  -H "X-Bootstrap-Secret: <your-bootstrap-secret>" \
  | jq -r .mcpAddCommand
```

Pipe the printed command straight into your shell:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer pk_<64 hex chars>" \
  --header "X-Workspace-Slug: projektor" \
  projektor \
  "https://<your-worker>.workers.dev/mcp/<workspace-uuid>"
```

Once connected, the agent has access to the full tool catalog — create issues, update statuses, search the wiki, plan sprints — anything a browser user can do.

### Production — mint a long-lived token

```bash
curl -s -X POST "https://<your-worker>.workers.dev/auth/tokens" \
  -H "Authorization: Bearer <cf-access-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","workspaceId":"<uuid>","scopes":["read","write"]}'
```

Then wire up the agent the same way as above.

See **[docs/mcp.md](./docs/mcp.md)** for the full connection guide, protocol reference, and tool catalog (54 tools across workspaces, projects, issues, sprints, wiki, comments, issue links, task types, task statuses, and custom fields).

## Development

```bash
pnpm install

# Copy dev config (one-time)
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set DEV_USER_EMAIL + BOOTSTRAP_SECRET
cp apps/web/.env.example      apps/web/.env        # set PUBLIC_WORKSPACE_SLUG=projektor

pnpm dev   # API on :8787, web on :4321
```

`pnpm dev` automatically applies D1 migrations to the local Miniflare database before starting, so a fresh checkout won't 500 with "no such table".

Seed a local workspace in one shot:

```bash
curl -H "X-Bootstrap-Secret: localdev" http://127.0.0.1:8787/bootstrap
```

Then open **http://localhost:4321** — with `DEV_USER_EMAIL` set, the dev-auth bypass logs you in automatically.

### Tests

```bash
pnpm --filter @projektor/api test   # vitest against an in-process Worker + Miniflare D1
pnpm turbo type-check               # tsc --noEmit across the monorepo
```

Both must be green before opening a PR — they mirror CI exactly (`.github/workflows/ci.yml`).

### Git hooks (lefthook)

`pnpm install` wires two hooks automatically:

- **pre-commit** — `pnpm turbo type-check` (fast; turbo-cached)
- **pre-push** — `pnpm --filter @projektor/api test` (~8 s vitest suite)

Bypass for WIP commits: `git commit --no-verify -m "wip: …"`

## Architecture (brief)

projektor has two surfaces over one service layer:

```
REST  /api/*         ─┐
                       ├─►  services/<domain>.ts  ─►  D1 (SQLite)
MCP   /mcp/:wsId    ─┘
```

Routes and MCP tools are thin wrappers. All business logic and SQL live in `services/`. Both surfaces must stay at parity — adding a feature to only one is a bug.

Runtime: **Hono on Cloudflare Workers** — no Node.js, no containers.
Storage: **D1** (relational), **KV** (sessions/cache), **R2** (attachments).
Frontend: **Astro + Preact**, served as static assets via Workers Static Assets; `/api/*` and `/mcp/*` always hit the Worker.

See [AGENTS.md](./AGENTS.md) for contributor conventions and the full architecture contract.
See [docs/marketecture.md](./docs/marketecture.md) for a Mermaid system diagram.

## Roadmap / Contributing

Feature requests and bugs are tracked in the live projektor dogfood instance — projektor is built with itself.

[AGENTS.md](./AGENTS.md) is the contributor guide: conventions, file layout, the service-layer contract, and how to work in parallel without conflicts. Read it before opening a PR.

CONTRIBUTING.md is not yet written; AGENTS.md is the current source of truth.
