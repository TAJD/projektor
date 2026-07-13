# projektor

> A self-hosted Jira + Notion hybrid that runs on serverless Cloudflare resources.

**Documentation:** <https://tajd.github.io/projektor/> - self-hosting, connecting an
agent, architecture, and the full MCP tool catalog.

**Live demo:** <https://projektor-demo.tajdickson.workers.dev> - see it running before you deploy your own (no login configured; see the [live demo guide](https://tajd.github.io/projektor/guides/live-demo/) for why).

## What it is

![Projektor issue backlog - list view with projects sidebar, issue refs, status, priority, and assignees](docs/images/backlog.png)

- **Projects** - named with short keys (`PROJ`, `BE`, …); issues reference as `PROJ-42`
- **Issues** - Jira-style tickets with status, priority, assignee, labels, parent/child hierarchy, and cross-issue links
- **Wiki** - nested markdown pages with revision history and full-text search
- **MCP server** - AI agents connect directly; every action available to the browser is available to an agent

## Features

A complete project tracker - issues, boards, sprints, a wiki - built so an AI agent can
do everything a person can. The shape of the tool follows from that; see
[the philosophy](https://tajd.github.io/projektor/philosophy/where-projektor-fits/).

- Issues with status, priority, assignee, labels, parent/child hierarchy, and issue links
- Kanban board + list view + sprint planning
- Wiki with nested pages, markdown, full-text search, and revision history
- MCP server - AI-native; Claude Code connects via `claude mcp add`
- File attachments (R2)
- Workspace + project + member management with role-based access (`owner` / `admin` / `member` / `viewer`)
- API tokens for agent access, workspace-scoped
- PWA - installable, offline shell

## Self-hosting

projektor deploys to **your own Cloudflare account** from a small **config-only repo**
([`projektor-deploy-example`](https://github.com/TAJD/projektor-deploy-example)) that
downloads a pre-built release artifact - no source checkout, no build step. Three ways
in, easiest first.

### One click

Use the **Deploy to Cloudflare** button in the
[deploy repo](https://github.com/TAJD/projektor-deploy-example): Cloudflare clones it
into your account, **auto-provisions D1, KV, and R2**, and deploys. Fill in your admin
email on the setup page and you're live.

### One command - or one prompt

Clone the deploy repo and run the zero-config script; wrangler auto-provisions the
resources, applies migrations, and deploys:

```bash
PROJEKTOR_REPO=you/projektor ADMIN_EMAILS=you@example.com ./deploy-auto.sh
```

Or hand the repo to an AI agent - *"deploy projektor to my Cloudflare account"* - and
let it run the same flow. See
[AGENT-DEPLOY.md](https://github.com/TAJD/projektor-deploy-example/blob/main/AGENT-DEPLOY.md).

### Then: configure access

The Worker is live, but **Cloudflare Access** must front it before anyone can log in
(a `*.workers.dev` toggle, or a custom domain). Then log in - the first user in
`ADMIN_EMAILS` becomes owner - and mint a token for agents. Full handoff:
[CONFIGURE.md](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md).

### Manual / CI

Prefer to create the resources yourself, keep your config private, or deploy from CI on
every push? See the **[deploy guide](https://tajd.github.io/projektor/guides/deploying/)** for the manual flow, the
Cloudflare API token recipe (it **must include D1**), and push-based auto-updates.

**Updating later:** bump `projektor.version` and re-deploy (or just push, if you wired CI).

## Connect an AI agent

projektor exposes a JSON-RPC 2.0 MCP endpoint at `POST /mcp/<workspaceId>`.
Any MCP-compatible agent (Claude Code, custom agents via the Anthropic SDK) can connect.

### Development - one command

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

Once connected, the agent has access to the full tool catalog - create issues, update statuses, search the wiki, plan sprints - anything a browser user can do.

### Production - mint a long-lived token

`/bootstrap` is disabled in production. Instead, log in through Cloudflare Access and
open **Settings → Tokens**: create a token and copy the ready-to-run `claude mcp add`
command shown beside it (token + workspace pre-filled). The full walkthrough - Access
setup, first login, token, MCP - is in
[CONFIGURE.md](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md).

See the **[agent connection guide](https://tajd.github.io/projektor/agents/mcp-connection/)** for the full connection guide, protocol reference, and tool catalog (<!-- gen-mcp-stats:start -->81 tools across 19 domains<!-- gen-mcp-stats:end --> - project data plus agent-coordination primitives).

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

Then open **http://localhost:4321** - with `DEV_USER_EMAIL` set, the dev-auth bypass logs you in automatically.

### Tests

```bash
pnpm --filter @projektor/api test   # vitest against an in-process Worker + Miniflare D1
pnpm turbo type-check               # tsc --noEmit across the monorepo
```

Both must be green before opening a PR - they mirror CI exactly (`.github/workflows/ci.yml`).

### Git hooks (lefthook)

`pnpm install` wires two hooks automatically:

- **pre-commit** - `pnpm turbo type-check` (fast; turbo-cached)
- **pre-push** - `pnpm --filter @projektor/api test` (~8 s vitest suite)

Bypass for WIP commits: `git commit --no-verify -m "wip: …"`

## Architecture (brief)

For a visual of how the system fits together, see the
[architecture overview](https://tajd.github.io/projektor/architecture/system-design/); the deep architecture lives in
[AGENTS.md](./AGENTS.md).

projektor has two surfaces over one service layer:

```
REST  /api/*         ─┐
                       ├─►  services/<domain>.ts  ─►  D1 (SQLite)
MCP   /mcp/:wsId    ─┘
```

Routes and MCP tools are thin wrappers. All business logic and SQL live in `services/`. Both surfaces must stay at parity - adding a feature to only one is a bug.

Runtime: **Hono on Cloudflare Workers** - no Node.js, no containers.
Storage: **D1** (relational), **KV** (cache), **R2** (attachments).
Frontend: **Astro + Preact**, served as static assets via Workers Static Assets; `/api/*` and `/mcp/*` always hit the Worker.

## Roadmap / Contributing

Feature requests and bugs are tracked in the live projektor dogfood instance - projektor is built with itself.

[AGENTS.md](./AGENTS.md) is the contributor guide: conventions, file layout, the service-layer contract, and how to work in parallel without conflicts. Read it before opening a PR.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how issues and PRs are handled,
[SECURITY.md](./SECURITY.md) to report vulnerabilities, and [AGENTS.md](./AGENTS.md) for
the engineering conventions. Licensed under [MIT](./LICENSE).
