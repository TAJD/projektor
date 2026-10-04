---
title: "Projektor vs beads: agent task tracker comparison"
description: "Projektor vs beads for AI coding agents: a deployed MCP issue tracker with leases and file claims, or a CLI tracker in your repo."
sidebar:
  label: "vs beads"
  order: 1
---
**Pick beads if your agents run on one machine against one repo and you want a
tracker with no server at all: it is a CLI, its ready queue is excellent, and it
stores issues in a Dolt database that syncs through your git remote. Pick
Projektor if agents on several machines, in CI or in hosted clients need to
coordinate through one shared service, with issue leases that expire, a cap on
how much work agents hold at once, file-level claims and a built-in wiki.**
beads is the better tool for "what can I work on next" inside a single repo;
Projektor is built for a fleet that does not share a disk.

*Checked against beads' README and docs on 2026-10-03. Sources are listed at the
end of the page. For the longer argument, see
[Projektor and the agent-coordination field](/projektor/philosophy/alternatives/).*

## At a glance

| | Projektor | beads |
|---|---|---|
| What it is | Issue tracker and wiki with an MCP server | "Distributed graph issue tracker for AI agents, powered by Dolt" |
| Where it runs | Your Cloudflare account: one Worker with D1, KV, R2 and Durable Objects | Your machine. Embedded Dolt by default, or an external `dolt sql-server`; sync with `bd dolt push` / `pull` via your git remote |
| Licence | MIT | MIT |
| How agents connect | Remote MCP over HTTP, with a bearer token or OAuth sign-in | The `bd` CLI (beads recommends it for agents with a shell), or the `beads-mcp` server for MCP-only clients |
| Claiming an issue | A lease tied to the agent's session; reclaimable once the session misses heartbeats for 120 s | `bd update <id> --claim` atomically sets assignee and `in_progress`; no expiry documented |
| Cap on concurrent agent work | Per-project cap on agent-leased issues, default 3 | Not documented |
| File-level coordination | Claims on exact file paths, all-or-nothing; a conflicting claim is refused unless forced | Not documented |
| Record of refused claims | Every refused or forced file claim is stored and shown as a contention heatmap | Not documented |
| Dependencies and next work | `blocks`, `relates_to`, `duplicates` links; a ranked next-work list that favours issues blocking others, but does not hide blocked issues | `blocks`, `related`, `parent-child` and more; `bd ready` lists only tasks with no open blockers |
| Agent messages | Workspace and per-issue channels | A message issue type with threading |
| Wiki / long-form docs | Built-in wiki with revisions, backlinks and drafts | No wiki; `bd remember` stores short project facts that `bd prime` injects |
| Web UI for humans | Built in: list and board views, sprints, wiki, flow metrics | None built in; community-built web UIs are listed |
| Price | Free software; you pay Cloudflare for usage beyond its free allowances | Free software; nothing to host |

## Choose Projektor if

- Agents run on more than one machine, in CI, or in hosted clients such as the
  Claude app, and all of them must see the same claims.
- You want a claim to expire on its own when an agent crashes, instead of
  someone clearing it by hand.
- You want to limit how many issues agents hold at once per project.
- Two agents on different issues might edit the same file, and you want the
  second claim refused before the edit, with a record of where that happens.
- You want a wiki and a web UI for humans in the same place as the backlog.

## Choose beads if

- Every agent works on one machine, and you would rather run no server at all.
- You want a sharp "what is unblocked right now" queue: `bd ready` filters out
  blocked work, which Projektor's ranking does not.
- You want issue history versioned in Dolt and synced through the git remote
  you already have, with offline use.
- You want compaction of old closed tasks to save context window, which beads
  documents and Projektor does not have.

## The trade-off in one line

Projektor puts a deployed service on every agent's write path; that is the
price of claims that agents on different machines can see. beads never pays
that price, and cannot offer those claims across machines without one. The
[agentic workflows](/projektor/agents/agent-workflows/) page explains the bet.

## Sources

- beads README: description, storage modes, `--claim`, `bd ready`, dependency
  types, messaging, compaction, licence badge:
  [github.com/steveyegge/beads](https://github.com/steveyegge/beads)
- beads licence (MIT):
  [LICENSE](https://github.com/steveyegge/beads/blob/main/LICENSE)
- `beads-mcp` and the recommendation to prefer the CLI where a shell exists:
  [integrations/beads-mcp/README.md](https://github.com/steveyegge/beads/blob/main/integrations/beads-mcp/README.md)
- Community web UIs:
  [docs/community-tools.md](https://github.com/steveyegge/beads/blob/main/docs/community-tools.md)
- Projektor leases, WIP cap and file claims: `apps/api/src/services/issue-leases.ts`
  and `apps/api/src/services/file-claims.ts` in
  [TAJD/projektor](https://github.com/TAJD/projektor); tools in the
  [MCP tool catalog](/projektor/agents/tool-catalog/)
