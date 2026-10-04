---
title: "Projektor vs Jira + Atlassian MCP: self-hosted alternative"
description: "Projektor vs Jira and Confluence via the Atlassian Rovo MCP server: self-hosted with agent coordination, or Atlassian Cloud at scale."
sidebar:
  label: "vs Jira / Atlassian MCP"
  order: 3
---
**Stay on Jira if your organisation already runs on Jira and Confluence: the
official Atlassian Rovo MCP server gives agents permission-aware access to
both on Atlassian Cloud, and switching away has a real cost. Pick Projektor if
you are a small team or solo developer who wants a self-hosted issue tracker
and wiki that you deploy to your own Cloudflare account, with coordination
built for parallel AI agents: issue leases that expire, a per-project cap on
agent work, and file-level claims.** Atlassian wins on breadth, admin
controls and ecosystem; Projektor is smaller, open source and agent-first.

*Checked against Atlassian's docs and the official MCP server repository on
2026-10-03. Sources are listed at the end of the page. For the longer
argument, see [Projektor and the agent-coordination field](/projektor/philosophy/alternatives/).*

## At a glance

| | Projektor | Jira + Atlassian Rovo MCP |
|---|---|---|
| What it is | Issue tracker and wiki with an MCP server | Jira (issues) and Confluence (wiki), reached by agents through the official Atlassian Rovo MCP server |
| Where it runs | Your Cloudflare account: one Worker with D1, KV, R2 and Durable Objects | The MCP server is a cloud bridge to an Atlassian Cloud site. Jira Data Center is self-managed, but Atlassian says its support ends on 28 March 2029 |
| Licence | MIT | Jira and Confluence are proprietary; the MCP server repository is Apache 2.0 |
| How agents connect | Remote MCP over HTTP, with a bearer token or OAuth sign-in | Remote MCP at `mcp.atlassian.com/v2/mcp`; OAuth 2.1 or API token; admins control which tools may connect |
| Claiming an issue | A lease tied to the agent's session; reclaimable once the session misses heartbeats for 120 s | Create, edit and assign issues through MCP tools; no lease or expiry documented |
| Cap on concurrent agent work | Per-project cap on agent-leased issues, default 3 | Not documented |
| File-level coordination | Claims on exact file paths, all-or-nothing; a conflicting claim is refused unless forced | Not documented |
| Record of refused claims | Every refused or forced file claim is stored and shown as a contention heatmap | Not documented |
| Dependencies and next work | `blocks`, `relates_to`, `duplicates` links; a ranked next-work list that favours issues blocking others | Jira issue links; search with JQL |
| Agent messages | Workspace and per-issue channels | Issue comments; no separate agent channel documented |
| Wiki / long-form docs | Built-in wiki with revisions, backlinks and drafts | Confluence, through the same MCP server (search with CQL) |
| Web UI for humans | Built in: list and board views, sprints, wiki, flow metrics | Jira and Confluence |
| Price | Free software; you pay Cloudflare for usage beyond its free allowances | Atlassian plans; some MCP calls consume Rovo credits |

## Choose Projektor if

- You want a self-hosted Jira alternative that deploys to your own Cloudflare
  account from a pre-built release (see the Self-hosting guide), not an enterprise
  rollout.
- You want issues and wiki in one small open-source system that you can read
  and change.
- Several AI agents work in parallel and you want the tracker to hand out
  expiring leases, cap agent work per project and refuse conflicting file
  claims.
- You want the agent interface to be the primary surface: everything a
  browser user can do is an MCP tool.

## Choose Jira + Atlassian MCP if

- Your organisation already standardises on Jira and Confluence; moving costs
  more than any feature difference.
- You need enterprise administration: Atlassian documents per-domain controls
  over which AI tools connect, and access scoped to each user's existing
  permissions.
- You need products Projektor does not have, such as Jira Service Management,
  Bitbucket or Loom, all reachable from the same MCP server.
- You want a vendor to run and support it.

## Sources

- Official Atlassian MCP server: cloud bridge to an Atlassian Cloud site,
  supported products, OAuth 2.1 or API token, Apache 2.0 licence:
  [github.com/atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server)
- Endpoint, supported clients, Rovo credits:
  [Getting started with the Atlassian Rovo MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/)
- Permissions and admin controls, Rovo credit use:
  [Understand Atlassian MCP server](https://support.atlassian.com/security-and-access-policies/docs/understand-atlassian-mcp-server/)
- Jira and Confluence tools, JQL and CQL search:
  [Supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)
- Data Center as Atlassian's self-managed edition, and its end of support on
  28 March 2029: [atlassian.com/enterprise/data-center](https://www.atlassian.com/enterprise/data-center)
- Projektor leases, WIP cap and file claims: `apps/api/src/services/issue-leases.ts`
  and `apps/api/src/services/file-claims.ts` in
  [TAJD/projektor](https://github.com/TAJD/projektor); deployment in
  [Self-hosting](/projektor/guides/self-hosting/)
