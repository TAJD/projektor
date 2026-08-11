# projektor

[![CI](https://github.com/TAJD/projektor/actions/workflows/ci.yml/badge.svg)](https://github.com/TAJD/projektor/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/TAJD/projektor)](https://github.com/TAJD/projektor/releases)
[![License: MIT](https://img.shields.io/github/license/TAJD/projektor)](./LICENSE)

> An issue tracker and wiki that an AI coding agent runs as a first-class client -
> self-hosted, cross-project, and cheap enough to run serverless.

**[Docs](https://tajd.github.io/projektor/)** ·
**[Live demo](https://projektor-demo.tajdickson.workers.dev)** ·
**[Deploy your own](https://github.com/TAJD/projektor-deploy-example)**

![Projektor issue backlog - list view with projects sidebar, issue refs, status, priority, and assignees](docs/images/backlog.png)

## What it is

A complete project tracker - issues, boards, sprints, a wiki - where every action a
person can take in the browser, an agent can take over MCP. Filing issues, moving
tickets, planning sprints, searching the wiki: the agent does it instead of asking you
to.

Jira and Notion are mature but human-first - agent access is bolted on, and you can't
cheaply self-host a slice of them. Git-file trackers like beads are agent-native but
live inside a single repo. Projektor is agent-native like beads, deployed and
cross-project like Jira, and runs on a single Cloudflare Worker in your own account.

## Core features

- **Issues** - Jira-style tickets: status, priority, assignee, labels, parent/child
  hierarchy, cross-issue links. Referenced as `PROJ-42`.
- **Boards and sprints** - kanban board, list view, sprint planning.
- **Wiki** - nested markdown pages with full-text search and revision history.
- **MCP server** - <!-- gen-mcp-stats:start -->113 tools across 22 domains<!-- gen-mcp-stats:end -->,
  driven by any MCP agent (Claude Code connects via `claude mcp add`). This is the
  primary surface, not an add-on.
- **Fleet coordination** - agent registry, file claims, and messages let parallel
  agents work one repo without colliding.
- **Ops** - file attachments, workspace/project/member management with roles, API
  tokens, installable PWA.

Runs serverless on your own Cloudflare account: Hono on Workers, D1 for data, KV for
cache, R2 for attachments. No servers, no containers.

## Get started

**Deploy it.** projektor installs into your Cloudflare account from a small config-only
repo that downloads a pre-built release - no source checkout, no build step. The
one-click **Deploy to Cloudflare** button in
[projektor-deploy-example](https://github.com/TAJD/projektor-deploy-example)
auto-provisions D1, KV, and R2 and deploys. A script and a CI flow are also available;
see the [deploy guide](https://tajd.github.io/projektor/guides/deploying/). Afterwards
you put **Cloudflare Access** in front of the Worker and mint an agent token -
[CONFIGURE.md](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md)
walks through it end to end.

**Connect an agent.** projektor exposes a JSON-RPC 2.0 MCP endpoint at
`POST /mcp/<workspaceId>`. In **Settings → Tokens**, create a token and copy the
ready-to-run `claude mcp add` command shown beside it - workspace and token pre-filled.
Full protocol reference and tool catalog: the
[agent connection guide](https://tajd.github.io/projektor/agents/mcp-connection/).

## Where to go next

| | |
|---|---|
| [Getting started](https://tajd.github.io/projektor/guides/getting-started/) | first workspace, projects, issues |
| [Self-hosting](https://tajd.github.io/projektor/guides/self-hosting/) & [deploying](https://tajd.github.io/projektor/guides/deploying/) | Cloudflare setup, API token scopes, updates |
| [MCP connection](https://tajd.github.io/projektor/agents/mcp-connection/) & [tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/) | wiring an agent up, every tool it gets |
| [Agentic workflows](https://tajd.github.io/projektor/agents/agent-workflows/) | how agents are meant to use the tracker |
| [System design](https://tajd.github.io/projektor/architecture/system-design/) | two surfaces (REST + MCP) over one service layer |
| [AGENTS.md](./AGENTS.md) | contributor guide: conventions, file layout, service-layer contract |

## Development

```bash
pnpm install

cp apps/api/.dev.vars.example apps/api/.dev.vars   # set DEV_USER_EMAIL + BOOTSTRAP_SECRET
cp apps/web/.env.example      apps/web/.env        # set PUBLIC_WORKSPACE_SLUG=projektor

pnpm dev   # API on :8787, web on :4321
```

`pnpm dev` applies D1 migrations to the local Miniflare database first, so a fresh
checkout won't 500 with "no such table". Seed a workspace with
`curl -H "X-Bootstrap-Secret: localdev" http://127.0.0.1:8787/bootstrap`, then open
<http://localhost:4321> - with `DEV_USER_EMAIL` set you're logged in automatically.

```bash
pnpm --filter @projektor/api test   # vitest against an in-process Worker + Miniflare D1
pnpm turbo type-check               # tsc --noEmit across the monorepo
```

Both must be green before opening a PR; `pnpm install` also wires lefthook pre-commit
and pre-push hooks. CI runs more - see [AGENTS.md](./AGENTS.md) for the full list and
the engineering conventions.

## Contributing

projektor is built with itself - the live dogfood instance tracks its own bugs and
feature requests. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how issues and PRs are
handled, [SECURITY.md](./SECURITY.md) to report vulnerabilities, and
[AGENTS.md](./AGENTS.md) before opening a PR. Licensed under [MIT](./LICENSE).
