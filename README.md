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
Issues, boards, sprints and a wiki are exposed over MCP
(<!-- gen-mcp-stats:start -->122 tools across 22 domains<!-- gen-mcp-stats:end -->), so the
agent files the ticket, moves it and writes the page instead of asking you to. The whole thing is one
Cloudflare Worker (Hono, D1, KV, R2) in your own account. No servers, no containers.

## Why it's different

- **Coordination lives in the work graph.** Issue leases and file claims sit in the same
  schema as the tickets, so "which issue is this claim for" is a join.
  [Coordination model](https://tajd.github.io/projektor/philosophy/coordination-model/)
- **Contention is data.** Refused and forced claims are logged and ranked in a code heatmap.
  [Conflict as an event log](https://tajd.github.io/projektor/philosophy/coordination-model/#conflict-as-an-event-log)
- **It is deployed, not local.** CI runners and agents on other machines can take leases
  too. [How Projektor differs](https://tajd.github.io/projektor/philosophy/alternatives/)
- **You still run the project.** Backlog, kanban, epics, sprints, a nested wiki with
  full-text search, flow metrics and a feedback widget, in a normal web app.

## Get started

**Deploy.** The one-click **Deploy to Cloudflare** button in
[projektor-deploy-example](https://github.com/TAJD/projektor-deploy-example) provisions D1,
KV and R2 and installs a pre-built release. Put Cloudflare Access in front of the Worker
before anyone logs in. See the [deploy guide](https://tajd.github.io/projektor/guides/deploying/).

**Connect Claude.** Add your instance as a connector and sign in with your web UI account;
Claude Code does it with `claude mcp add --transport http projektor "https://<host>/mcp/<workspace-id>"`.
Headless agents use a workspace API token instead. See
[connecting an agent](https://tajd.github.io/projektor/agents/mcp-connection/).

## Docs

| | |
|---|---|
| [Getting started](https://tajd.github.io/projektor/guides/getting-started/) | first workspace, projects, issues |
| [Deploying](https://tajd.github.io/projektor/guides/deploying/) | Cloudflare setup, Access, updates |
| [MCP connection](https://tajd.github.io/projektor/agents/mcp-connection/) and [tool catalog](https://tajd.github.io/projektor/agents/tool-catalog/) | wiring an agent up, every tool it gets |
| [Agentic workflows](https://tajd.github.io/projektor/agents/agent-workflows/) | how agents are meant to use the tracker |
| [System design](https://tajd.github.io/projektor/architecture/system-design/) | REST and MCP over one service layer |

## Development

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # DEV_USER_EMAIL + BOOTSTRAP_SECRET
cp apps/web/.env.example      apps/web/.env        # PUBLIC_WORKSPACE_SLUG=projektor
pnpm dev                                           # API :8787, web :4321

pnpm --filter @projektor/api test   # vitest against an in-process Worker + D1
pnpm turbo type-check               # tsc --noEmit across the monorepo
```

Seed a workspace with `curl -H "X-Bootstrap-Secret: localdev" http://127.0.0.1:8787/bootstrap`,
then open <http://localhost:4321>. [AGENTS.md](./AGENTS.md) has the full pre-PR checklist
and the conventions.

## Contributing

Projektor is built with itself. [CONTRIBUTING.md](./CONTRIBUTING.md) explains how issues
and PRs are handled, [SECURITY.md](./SECURITY.md) how to report a vulnerability. Licensed
under [MIT](./LICENSE).
