---
title: "Projektor vs MCP Agent Mail: coordinating parallel coding agents"
description: "Projektor vs MCP Agent Mail: an issue tracker with leases and file claims, or a mail server for agents with advisory file reservations."
sidebar:
  label: "vs MCP Agent Mail"
  order: 5
---
**MCP Agent Mail and Projektor solve overlapping halves of the same problem.
Agent Mail is a messaging layer: agents get identities, inboxes, threads and
advisory file reservations with expiry, plus a pre-commit guard, and it is
better than Projektor at letting agents negotiate a conflict after it is
detected. It is not a task tracker; its README tells you to use Beads as the
task queue. Pick Projektor if you want the backlog, issue leases, a cap on
agent work, file claims and a wiki in one deployed service. Pick Agent Mail
(usually with Beads) if your agents mainly need to talk to each other and
reserve files, on infrastructure you run yourself.**

*Checked against the MCP Agent Mail README on 2026-10-03. Sources are listed
at the end of the page. For the longer argument, including the Rust rewrite,
see [Projektor and the agent-coordination field](/projektor/philosophy/alternatives/).*

## At a glance

| | Projektor | MCP Agent Mail |
|---|---|---|
| What it is | Issue tracker and wiki with an MCP server | "A mail-like coordination layer for coding agents": identities, inbox/outbox, threads, file reservations |
| Where it runs | Your Cloudflare account: one Worker with D1, KV, R2 and Durable Objects | An HTTP-only FastMCP server you run (default port 8765), storing artifacts in Git and indexes in SQLite |
| Licence | MIT | MIT with an added OpenAI/Anthropic rider |
| How agents connect | Remote MCP over HTTP, with a bearer token or OAuth sign-in | MCP over HTTP with a bearer token; the installer wires up detected coding agents |
| Claiming an issue | A lease tied to the agent's session; reclaimable once the session misses heartbeats for 120 s | Not a tracker; the README says to keep tasks in Beads |
| Cap on concurrent agent work | Per-project cap on agent-leased issues, default 3 | Not documented |
| File-level coordination | Claims on exact file paths, all-or-nothing; a conflicting claim is refused unless forced | Advisory reservations on files or globs, exclusive or shared, with a TTL; an optional pre-commit guard blocks conflicting commits |
| Record of refused claims | Every refused or forced file claim is stored and shown as a contention heatmap | Web UI lists active and past reservations |
| Dependencies and next work | `blocks`, `relates_to`, `duplicates` links; a ranked next-work list that favours issues blocking others | Delegated to Beads |
| Agent messages | Workspace and per-issue channels | The core feature: threaded Markdown messages with attachments, search, acknowledgements, and a human overseer composer |
| Wiki / long-form docs | Built-in wiki with revisions, backlinks and drafts | No wiki; messages are archived in Git |
| Web UI for humans | Built in: list and board views, sprints, wiki, flow metrics | Server-rendered mail viewer at `/mail` |
| Price | Free software; you pay Cloudflare for usage beyond its free allowances | Free software; a separate companion app and automation stack is commercial |

## Choose Projektor if

- You want tasks, claims, messages and docs in one service instead of a
  tracker plus a mail server.
- You want issue-level leases and a per-project cap on agent work, not only
  file reservations.
- Agents run on several machines, in CI or in hosted clients, and you would
  rather deploy to Cloudflare than expose and operate your own HTTP server.
- You want refused claims kept as data, so you can see which paths are
  contended over time.

## Choose MCP Agent Mail if

- Your agents need to discuss work with each other: threads, acknowledgements
  and a human overseer are its centre, and Projektor's channels are simpler.
- You want glob reservations and a pre-commit guard that stops a conflicting
  commit; Projektor's claims are exact paths and are checked when claimed,
  not at commit time.
- You already use Beads for tasks and want the messaging layer its README is
  designed around.
- You want everything on your own machine, in Git and SQLite.

## Sources

- MCP Agent Mail README: description, HTTP-only FastMCP server, Git and
  SQLite, default port, bearer token, file reservations on files and globs with
  TTL and exclusive flag, pre-commit guard, Beads as the task queue, web UI at
  `/mail`, human overseer, commercial companion stack:
  [github.com/Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
- Licence (MIT with OpenAI/Anthropic rider):
  [LICENSE](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/main/LICENSE)
- Rust rewrite: [github.com/Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)
- Projektor file claims and recorded conflicts: `apps/api/src/services/file-claims.ts`
  and `apps/api/src/services/code-heatmap.ts` in
  [TAJD/projektor](https://github.com/TAJD/projektor); messages and claims in
  the [MCP tool catalog](/projektor/agents/tool-catalog/)
