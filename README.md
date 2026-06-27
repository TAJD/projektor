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

You need a Cloudflare account and `wrangler` installed (`npm i -g wrangler`).

### 1. Fork the deploy template

The [`deploy-template/`](./deploy-template/) directory is a ready-made deploy repo.
Fork or copy it to your own GitHub repository — that repo becomes your private deploy config.

### 2. Clone with the submodule

```bash
git clone --recurse-submodules https://github.com/YOU/your-deploy-repo
cd your-deploy-repo
```

The `projektor/` directory inside is this repo checked out as a git submodule.

### 3. Provision Cloudflare resources

```bash
bash setup.sh
```

`setup.sh` runs three `wrangler` commands and prints the IDs you need:

| Command | What it creates |
|---------|-----------------|
| `wrangler d1 create projektor` | SQLite database — relational data |
| `wrangler kv namespace create projektor` | KV namespace — sessions and cache |
| `wrangler r2 bucket create projektor-files` | R2 bucket — file attachments |

### 4. Fill in wrangler.toml

Open `wrangler.toml` and replace every `REPLACE_WITH_…` placeholder with the values printed by `setup.sh`:

```toml
[[d1_databases]]
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"   # from step 3

[[kv_namespaces]]
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"            # from step 3

[vars]
CF_ACCESS_TEAM_DOMAIN = "REPLACE_WITH_YOUR_TEAM.cloudflareaccess.com"
CF_ACCESS_AUDIENCE    = "REPLACE_WITH_YOUR_CF_ACCESS_AUDIENCE_TAG"
ADMIN_EMAILS          = "you@example.com"
```

> **Cloudflare Access is required.** projektor uses it for browser auth (SSO / Zero Trust).
> Set up an Access application pointing at your Worker URL before deploying.

### 5. Set secrets

```bash
wrangler secret put JWT_SECRET   # any random string — used for API token signing
```

Optional (if you prefer secrets over toml vars):

```bash
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put CF_ACCESS_AUDIENCE
```

### 6. Apply migrations and deploy

```bash
# Apply the D1 schema migrations
wrangler d1 migrations apply projektor --remote --config ../wrangler.toml

# Deploy the Worker + static frontend
wrangler deploy --config ../wrangler.toml
```

### 7. Bootstrap your workspace

On first load the Worker auto-provisions a workspace for the first user in `ADMIN_EMAILS` via Cloudflare Access. Open your Worker URL, log in through Cloudflare Access, and projektor creates your workspace automatically.

To connect an AI agent immediately (dev/staging only), use the bootstrap endpoint — see [Connect an AI agent](#connect-an-ai-agent) below.

**Updating projektor later:**

```bash
git submodule update --remote --merge
git add projektor
git commit -m "chore: bump projektor"
git push   # GitHub Actions deploys automatically
```

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
