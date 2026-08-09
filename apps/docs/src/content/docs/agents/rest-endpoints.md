---
title: "REST endpoints"
description: "The small, stable slice of the REST API that guides depend on, alongside the primary MCP surface."
sidebar:
  order: 6
---
Projektor's REST API (`/api/*`) is the SPA's private, versionless contract - it can
change shape without notice, and agents should use [MCP](/projektor/agents/mcp-connection/)
instead wherever a tool exists. A handful of endpoints are the deliberate exception,
documented here as a stable subset you can depend on. Two kinds qualify:

- **No MCP equivalent** — things the browser can do that don't fit the JSON-RPC/tool-call
  shape at all (binary uploads, redirects, public unauthenticated links).
- **Fetchable without an MCP session** — the shipped specs and playbooks, which have MCP
  tools too, but which CI jobs and setup scripts need to pull over plain HTTP before any
  agent is connected.

All `/api/*` endpoints below require the same bearer-token auth as MCP
(`Authorization: Bearer pk_...` plus `X-Workspace-Slug`) unless marked **public**. The
`/auth/*` endpoints are the exception - they authenticate the *user*, not a workspace,
so they take a Cloudflare Access session (or no auth at all) instead.

## File attachments

Binary upload/download doesn't fit JSON-RPC, so attachments are REST-only.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/files` | List attachments for an issue or wiki page (`?entityType=issue\|wiki_page&entityId=`) |
| `POST` | `/api/files` | Upload a file (multipart) |
| `POST` | `/api/files/links` | Attach an external link instead of a binary |
| `GET` | `/api/files/:id` | Download an attachment |
| `DELETE` | `/api/files/:id` | Delete an attachment |

## Auth and tokens

Logging in and minting long-lived tokens are browser flows, not agent tool calls.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/auth/login` | Login redirect (browser only) |
| `POST` | `/auth/tokens` | Mint an API token for the current user |
| `DELETE` | `/auth/tokens/:id` | Revoke a token |

## Workspace-scoped API tokens

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/api/workspaces/:slug/tokens` | Create a token scoped to a workspace |
| `GET` | `/api/workspaces/:slug/tokens` | List a workspace's tokens |
| `DELETE` | `/api/workspaces/:slug/tokens/:tokenId` | Revoke a workspace token |
| `GET` | `/api/workspaces/:slug/mcp-info` | Ready-to-use MCP connection details for a workspace |

## Public issue sharing

A share link lets someone without a Projektor account view a single issue - the
whole point is that it works without auth, so it can't be an MCP tool.

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/api/issues/:id/share` | Create a public share link for an issue |
| `DELETE` | `/api/issues/:id/share` | Revoke the share link |
| `GET` | `/api/share/:token` | **Public.** View the shared issue, no auth |

## Public feedback submission

Feedback comes from end users of *your* product, not from an agent with a
workspace token - it has to be public.

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/api/feedback/submit` | **Public.** Submit feedback via a feedback-source key. See [Feedback widget integration](/projektor/guides/feedback-widget-integration/). |

## Workflow spec and playbooks

The [workflow spec](/projektor/agents/workflow-spec/) and the
[playbooks](/projektor/agents/playbooks/) are served from the same constants the MCP
tools read, so a fetch here and a `get_playbook` call can never drift. These have MCP
equivalents (`get_workflow`, `list_playbooks`, `get_playbook`) and an agent should
prefer those; the REST form is for everything that isn't an MCP client.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/workflow` | The workflow spec: definition of ready, state machine, review gates |
| `GET` | `/api/playbooks` | List the shipped playbooks |
| `GET` | `/api/playbooks/:name` | One playbook's full markdown |

`compose_playbook` — which fills a playbook's template with live epic data — is MCP-only,
so these return the templates as shipped rather than a composed directive.

## The inverse case

Two tools have no REST equivalent. `get_prioritized_issues` (the "what should I work
on next?" ranking) is MCP-only - it's an agent-facing entry point the SPA doesn't
need, since a human browsing issues doesn't want a single ranked queue. So is
`compose_playbook`, for the same reason: it exists to hand an agent a filled-in
directive, which is not something a browser has any use for.

Everything else - issues, sprints, wiki, comments, links, members, projects - is
available over MCP and should be called there. See the
[MCP tool catalog](/projektor/agents/tool-catalog/) for the full list.
