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

## One work graph, not a tracker plus a sidecar

Running a fleet of agents normally means assembling three things: a tracker for the
work, a coordination layer so two agents do not edit the same file, and worktree
tooling to keep their checkouts apart. That leaves two or three sources of truth about
what is being worked on, and nothing that can answer a question spanning them.

In Projektor the coordination state *is* the work graph. The lease is on the issue and
the claim is on the file, in one schema behind one auth boundary:

- **Issue leases** — an agent takes a work-item lease before starting, and a
  per-project cap (`agent_wip_limit`, default 3) bounds how many issues the fleet can
  hold at once. That is admission control on the backlog, not a rate limit: it decides
  how much work is allowed to be in flight.
- **File claims** — path-level claims stop two agents editing the same code. A refused
  claim is rejected whole and names the issue and agent already holding the path, so the
  blocked agent knows who to talk to, and every contended path is recorded.
- **Liveness** — an issue lease is derived from its holder's heartbeat, so a lease whose
  agent stopped reporting is reclaimed by the next claim in the same call. An agent that
  crashes mid-ticket does not deadlock the backlog behind it. File claims are released on
  session end or explicitly, not by TTL — the
  [coordination model](https://tajd.github.io/projektor/philosophy/coordination-model/)
  is explicit about that asymmetry.

Because it is one graph, "which issue is this claim for" is a join, not an integration.
The [coordination model](https://tajd.github.io/projektor/philosophy/coordination-model/)
documents the design. [How Projektor differs](https://tajd.github.io/projektor/philosophy/alternatives/)
compares it against beads, MCP Agent Mail, Linear and the worktree tools, and is honest
about what each of those does better.

## Contention is data

When a claim collides, most systems return an error and forget it. Projektor writes the
contended path to an event log — whether the claim was refused or forced through — and
ranks it, so the code heatmap has two modes: where the fleet is *working*, and where the
fleet is *colliding*.

That closes a loop back into the backlog. A directory that shows up hot in contention
week after week is telling you something about how the work is sliced — two tickets that
keep fighting over the same module probably wanted to be one ticket, or the module
wanted splitting. Refused claims are evidence about your plan, not just failures.

## Both surfaces, checked mechanically

REST and MCP are two doors into one service layer:

```
REST  /api/*         ─┐
                      ├─►  services/<domain>.ts  ─►  D1 (SQLite)
MCP   /mcp/:wsId    ─┘
```

Routes and MCP tools are thin wrappers; the business logic and the SQL live in
`services/`. An agent is not driving a reduced API built for robots, it is calling the
code the browser calls.

That used to be a convention held up by review. It is now a test: `mcp-parity.node.test.ts`
cross-references every exported service function against the REST routes, the runtime MCP
registry and the documented catalog, and fails the build on drift — including a catalog
reordered without the dispatch table. Operations deliberately on one surface only are
enumerated with a reason each, and the test fails if that list goes stale, so the
exceptions stay few and visible rather than accumulating quietly.

Every surface described here was used to build Projektor: the epics, the tickets, the
coordination primitives and the wiki pages all carried their own development. The tool
catalog is a discovered surface, not a designed one.

## You still run the project

Agents do the filing. You do the steering, and you do it in a normal web app: backlog
and kanban board, epics, sprint planning, a nested wiki with full-text search and
revision history, flow metrics, and a feedback widget that turns user reports into
issues. Nothing an agent does is buried in a log - it lands on the board, where you can
read it, argue with it and move it.

## What is in it

- **Issues** - status, priority, assignee, labels, parent/child hierarchy and
  cross-issue links. Referenced as `PROJ-42`.
- **Boards and sprints** - kanban board, list view, sprint planning, flow metrics.
- **Wiki** - nested markdown pages, full-text search, revision history.
- **MCP server** - the primary surface, not an add-on. Any MCP agent connects; Claude
  Code does it with `claude mcp add`.
- **Fleet coordination** - agent registry, issue leases with a per-project WIP cap, file
  claims, agent messages, and a contention heatmap over every contended path.
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
| [Coordination model](https://tajd.github.io/projektor/philosophy/coordination-model/) | leases, claims, liveness and contention as a designed system |
| [How Projektor differs](https://tajd.github.io/projektor/philosophy/alternatives/) | compared against beads, MCP Agent Mail, Hiveship, Linear |
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
