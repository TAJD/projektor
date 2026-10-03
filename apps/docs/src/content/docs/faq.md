---
title: "Projektor FAQ"
description: "Short answers about Projektor: what it is, connecting Claude Code, stopping agents editing the same file, Cloudflare cost, and alternatives."
---
Short answers to the questions people ask most often about Projektor. Each
answer stands on its own and links to the page with the detail.

## What is Projektor?

Projektor is an open-source, self-hosted, MCP-native issue tracker and wiki
that runs in a single Cloudflare Worker. AI agents use it through an MCP
server that exposes everything a browser user can do, and humans use the same
data through a web UI with list and board views, sprints and a wiki. It is MIT
licensed and you deploy it to your own Cloudflare account.
See [Your first ten minutes](/projektor/guides/getting-started/).

## How do I give Claude Code a task tracker?

Deploy Projektor to your Cloudflare account, mint an API token, and add it as
an HTTP MCP server with `claude mcp add --transport http`, passing the token in
an `Authorization` header and your workspace's MCP URL. Claude Code can then
create, search, claim and close issues and read or write wiki pages through
MCP tools. The exact command and a smoke test are in
[Connect an AI agent](/projektor/agents/mcp-connection/).

## How do multiple AI agents avoid editing the same file?

In Projektor an agent claims the exact file paths it plans to edit before it
starts, and the claim is all-or-nothing: if another live agent holds any of
those paths, the whole claim is refused unless the caller explicitly forces it.
Claims are released when the agent finishes or its session stops sending
heartbeats, and every refused or forced claim is recorded so you can see which
paths are contended over time.
See [Agentic workflows](/projektor/agents/agent-workflows/).

## What happens if an agent crashes while it holds a task?

Projektor ties each issue lease and file claim to the agent's session, and a
session counts as live only while it has sent a heartbeat in the last 120
seconds. Once a crashed agent's session goes stale, the next agent to claim
the same issue or files takes them over automatically; nobody has to clear
them by hand. See [Agentic workflows](/projektor/agents/agent-workflows/).

## Is there a self-hosted Jira alternative that works with AI agents?

Projektor is one: an issue tracker and wiki that you deploy to your own
Cloudflare account, with an MCP server as its primary interface and
coordination built for several agents working at once. It is much smaller than
Jira and Confluence and has no equivalent of their enterprise administration
or ecosystem, so it suits small teams and solo developers better than large
organisations. For a side-by-side table, see
[Projektor vs Jira + Atlassian MCP](/projektor/compare/jira/).

## What does it cost to run Projektor on Cloudflare?

Projektor is free software, and you pay Cloudflare only for what your instance
uses beyond Cloudflare's free allowances, such as 100,000 Worker requests a day
and 10 ms of CPU time per invocation on Workers Free, plus separate free limits
for D1, KV and R2. Assuming a small team stays inside those allowances,
Cloudflare's published pricing charges nothing, but the project has not
measured whether every request fits the free plan's CPU limit, so it cannot
promise a $0 bill; Workers Paid starts at $5 a month per account, and R2 needs
a subscription added through a checkout flow even for free usage. Cloudflare
Access, which must sit in front of the instance, has a free plan that
Cloudflare describes as "best for teams under 50 users". Check
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) and
[Access](https://www.cloudflare.com/sase/products/access/) for current
figures, and [Self-hosting](/projektor/guides/self-hosting/) for what gets
provisioned.

## How is Projektor different from beads?

beads is a CLI issue tracker that runs on your machine and stores issues in a
Dolt database synced through your git remote; Projektor is a deployed service
that every agent reaches over MCP, wherever it runs. beads has the sharper
"what is unblocked" queue and needs no server; Projektor adds issue leases
that expire, a per-project cap on agent work, file claims, a wiki and a web UI.
See [Projektor vs beads](/projektor/compare/beads/).

## How is Projektor different from Linear?

Linear is a polished hosted product with an official MCP server and native
agent delegation, and it is the more mature tool. Projektor is open source and
self-hosted, and it adds coordination that Linear does not document: issue
leases that expire, a per-project cap on agent-held issues, and file-level
claims. See [Projektor vs Linear + MCP](/projektor/compare/linear/).

## Does Projektor work with Cursor and Claude Desktop?

The Claude app, including Claude Desktop, connects through Settings →
Connectors: you add your instance's MCP URL as a custom connector and sign in,
with no token to paste. Projektor's docs do not include a tested Cursor setup;
Cursor's own docs say it can connect to remote MCP servers by URL with custom
headers, which is all Projektor's endpoint needs (an `Authorization` bearer
token), but that combination has not been verified by the project. See
[Connect an AI agent](/projektor/agents/mcp-connection/#3b-connect-the-claude-app)
and [Cursor's MCP docs](https://cursor.com/docs/context/mcp).

## Does Projektor include a wiki?

Yes. Each workspace has a wiki with revision history and diffs, backlinks,
drafts, templates and stale-page checks, and agents read and edit it through
the same MCP server as issues. A page can be patched section by section, so an
agent does not have to rewrite a whole page to change one part. See the
[MCP tool catalog](/projektor/agents/tool-catalog/).
