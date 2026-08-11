# projektor

[![CI](https://github.com/TAJD/projektor/actions/workflows/ci.yml/badge.svg)](https://github.com/TAJD/projektor/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/TAJD/projektor)](https://github.com/TAJD/projektor/releases)
[![License: MIT](https://img.shields.io/github/license/TAJD/projektor)](./LICENSE)

> **AI-native project management, self-hosted on Cloudflare.**

**[Docs](https://tajd.github.io/projektor/)** ·
**[Live demo](https://projektor-demo.tajdickson.workers.dev)** ·
**[Deploy your own](https://github.com/TAJD/projektor-deploy-example)**

![Projektor issue backlog - list view with projects sidebar, issue refs, status, priority, and assignees](docs/images/backlog.png)

## What it is

Projektor is an issue tracker and wiki that an AI coding agent runs as well as you do.
It holds issues, boards, sprints and a wiki, and it exposes
<!-- gen-mcp-stats:start -->113 tools across 22 domains<!-- gen-mcp-stats:end --> over MCP,
so the agent files the ticket, moves it and writes the page instead of asking you to.
The whole thing is one Cloudflare Worker in your own account.

Other trackers were built for people and had agent access bolted on later. Git-file
trackers such as beads are agent-native but live inside a single repo. Projektor is
agent-native from the schema up, works across projects, and is cheap enough to leave
running.

## Every action, both surfaces

REST and MCP are two doors into one service layer:

```
REST  /api/*         ─┐
                      ├─►  services/<domain>.ts  ─►  D1 (SQLite)
MCP   /mcp/:wsId    ─┘
```

Routes and MCP tools are thin wrappers. The business logic and the SQL live in
`services/`. That is what makes the parity claim hold: an agent is not driving a
reduced API built for robots, it is calling the code the browser calls. Shipping a
feature to one surface and not the other counts as a bug, not a backlog item.

## You still run the project

Agents do the filing. You do the steering, and you do it in a normal web app: backlog
and kanban board, epics, sprint planning, a nested wiki with full-text search and
revision history, flow metrics, and a feedback widget that turns user reports into
issues. Nothing an agent does is buried in a log - it lands on the board, where you can
read it, argue with it and move it.

Agents get their own coordination primitives as well - a registry, file claims and
messages - so several can work one repo without treading on each other.

## What is in it

- **Issues** - status, priority, assignee, labels, parent/child hierarchy and
  cross-issue links. Referenced as `PROJ-42`.
- **Boards and sprints** - kanban board, list view, sprint planning, flow metrics.
- **Wiki** - nested markdown pages, full-text search, revision history.
- **MCP server** - the primary surface, not an add-on. Any MCP agent connects; Claude
  Code does it with `claude mcp add`.
- **Fleet coordination** - agent registry, file claims and messages for parallel agents.
- **Ops** - file attachments, workspaces, projects and members with roles, scoped API
  tokens, share links, installable PWA.

Serverless on your own Cloudflare account: Hono on Workers, D1 for data, KV for cache,
R2 for attachments. No servers, no containers.

## Deploy it

Projektor installs into your Cloudflare account from a small config-only repo that
downloads a pre-built release. There is no source checkout and no build step. The
one-click **Deploy to Cloudflare** button in
[projektor-deploy-example](https://github.com/TAJD/projektor-deploy-example) provisions
D1, KV and R2 for you and deploys. A script and a CI flow do the same job; see the
[deploy guide](https://tajd.github.io/projektor/guides/deploying/).

Put **Cloudflare Access** in front of the Worker before anyone logs in, then mint a
token for your agents.
[CONFIGURE.md](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md)
covers both.

## Connect an agent

Projektor serves a JSON-RPC 2.0 MCP endpoint at `POST /mcp/<workspaceId>`. Open
**Settings → Tokens**, create a token, and copy the `claude mcp add` command shown
beside it with the workspace and token filled in. The
[agent connection guide](https://tajd.github.io/projektor/agents/mcp-connection/) has
the protocol reference and the full tool catalog.

## Where to go next

| | |
|---|---|
| [Getting started](https://tajd.github.io/projektor/guides/getting-started/) | first workspace, projects, issues |
| [Self-hosting](https://tajd.github.io/projektor/guides/self-hosting/) and [deploying](https://tajd.github.io/projektor/guides/deploying/) | Cloudflare setup, API token scopes, updates |
| [MCP connection](https://tajd.github.io/projektor/agents/mcp-connection/) and [tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/) | wiring an agent up, every tool it gets |
| [Agentic workflows](https://tajd.github.io/projektor/agents/agent-workflows/) | how agents are meant to use the tracker |
| [System design](https://tajd.github.io/projektor/architecture/system-design/) | the two surfaces and the service layer beneath them |
| [AGENTS.md](./AGENTS.md) | contributor guide: conventions, file layout, the service-layer contract |

## Development

```bash
pnpm install

cp apps/api/.dev.vars.example apps/api/.dev.vars   # set DEV_USER_EMAIL + BOOTSTRAP_SECRET
cp apps/web/.env.example      apps/web/.env        # set PUBLIC_WORKSPACE_SLUG=projektor

pnpm dev   # API on :8787, web on :4321
```

`pnpm dev` applies D1 migrations to the local Miniflare database first, so a fresh
checkout will not 500 with "no such table". Seed a workspace with
`curl -H "X-Bootstrap-Secret: localdev" http://127.0.0.1:8787/bootstrap`, then open
<http://localhost:4321>. With `DEV_USER_EMAIL` set, the dev-auth bypass logs you in.

```bash
pnpm --filter @projektor/api test   # vitest against an in-process Worker + Miniflare D1
pnpm turbo type-check               # tsc --noEmit across the monorepo
```

Both must be green before you open a PR. `pnpm install` also wires the lefthook
pre-commit and pre-push hooks. CI runs more; [AGENTS.md](./AGENTS.md) lists it, along
with the engineering conventions.

## Contributing

Projektor is built with itself - the live dogfood instance tracks its own bugs and
feature requests. [CONTRIBUTING.md](./CONTRIBUTING.md) explains how issues and PRs are
handled, [SECURITY.md](./SECURITY.md) how to report a vulnerability, and
[AGENTS.md](./AGENTS.md) what to read before opening a PR. Licensed under
[MIT](./LICENSE).
