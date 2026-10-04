---
title: "Projektor vs Linear + MCP: issue trackers for AI agents"
description: "Projektor vs Linear with its MCP server: a self-hosted tracker with agent leases and file claims, or a polished hosted product."
sidebar:
  label: "vs Linear + MCP"
  order: 2
---
**Pick Linear if you want a polished, hosted issue tracker for a whole team,
with an official remote MCP server, native agent delegation
and a wide integration ecosystem. Pick Projektor if you need to self-host,
want the source, or are running several AI agents in parallel and need the
tracker itself to stop them colliding: issue leases that expire, a per-project
cap on agent work, and file-level claims.** Linear is the more mature product; Projektor's case rests on self-hosting and on coordination
features that Linear does not document.

*Checked against Linear's docs and pricing page on 2026-10-03. Sources are
listed at the end of the page. For the longer argument, see
[Projektor and the agent-coordination field](/projektor/philosophy/alternatives/).*

## At a glance

| | Projektor | Linear + MCP |
|---|---|---|
| What it is | Issue tracker and wiki with an MCP server | Hosted issue tracking and project management, with an official MCP server |
| Where it runs | Your Cloudflare account: one Worker with D1, KV, R2 and Durable Objects | Linear's cloud; its pricing page lists no self-hosted plan |
| Licence | MIT | Proprietary |
| How agents connect | Remote MCP over HTTP, with a bearer token or OAuth sign-in | Remote MCP at `mcp.linear.app/mcp` (Streamable HTTP, SSE fallback); OAuth 2.1 or API key; a read-only endpoint too |
| Claiming an issue | A lease tied to the agent's session; reclaimable once the session misses heartbeats for 120 s | Assign (delegate) an issue to an installed agent; the human assignee stays responsible; no lease or expiry documented |
| Cap on concurrent agent work | Per-project cap on agent-leased issues, default 3 | Not documented |
| File-level coordination | Claims on exact file paths, all-or-nothing; a conflicting claim is refused unless forced | Not documented |
| Record of refused claims | Every refused or forced file claim is stored and shown as a contention heatmap | Not documented |
| Dependencies and next work | `blocks`, `relates_to`, `duplicates` links; a ranked next-work list that favours issues blocking others | Related, blocked by, blocking and duplicate relations |
| Agent messages | Workspace and per-issue channels | Issue comments; no separate agent channel documented |
| Wiki / long-form docs | Built-in wiki with revisions, backlinks and drafts | Documents attached to projects, initiatives, teams, issues and cycles, with version history |
| Web UI for humans | Built in: list and board views, sprints, wiki, flow metrics | Linear's main product |
| Price | Free software; you pay Cloudflare for usage beyond its free allowances | Free plan (unlimited members, 250 issues, 2 teams); paid plans per user; agents are not billable seats |

## Choose Projektor if

- You must self-host, or you want to read and change the source.
- Several agents work the same backlog at once, and you want a claim that
  expires when an agent dies and a cap on how many issues agents hold.
- Agents on different issues may touch the same files, and you want the second
  claim refused before the edit.
- You want the wiki to be a first-class part of the same MCP server, not a
  document attached to a project.

## Choose Linear if

- You want a hosted tool with nothing to deploy or operate.
- Humans spend most of their day in the tracker, and product polish matters.
- You rely on integrations and agents from Linear's ecosystem; it lists
  clients from Claude and Cursor to VS Code and Zed for its MCP server.
- Your team is past the free plan's limits and per-seat pricing suits you.

## Sources

- Linear MCP server: endpoints, transport, auth, listed clients:
  [linear.app/docs/mcp](https://linear.app/docs/mcp)
- Delegating issues to agents, human assignee responsibility, agents not
  billable: [linear.app/docs/agents-in-linear](https://linear.app/docs/agents-in-linear)
- Plans, free plan limits, no self-hosted plan listed:
  [linear.app/pricing](https://linear.app/pricing)
- Issue relations: [linear.app/docs/issue-relations](https://linear.app/docs/issue-relations)
- Documents: [linear.app/docs/project-documents](https://linear.app/docs/project-documents)
- Projektor leases, WIP cap and file claims: `apps/api/src/services/issue-leases.ts`
  and `apps/api/src/services/file-claims.ts` in
  [TAJD/projektor](https://github.com/TAJD/projektor); connecting clients in
  [Connect an AI agent](/projektor/agents/mcp-connection/)
