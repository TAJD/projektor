---
title: "Where your data lives"
description: "What Projektor stores, where it stores it, and every outbound request the Worker makes. There is no telemetry, analytics or update check."
sidebar:
  order: 2
---
## The short version

All of your data lives in your own Cloudflare account. The code ships no telemetry, no
third-party analytics and no update check. The Worker makes outbound requests only to
verify sign-ins, to build link previews, and, if you turn it on, to read your own MCP
usage metrics.

## What lives where

| Data | Storage | Account |
|---|---|---|
| Issues, comments, sprints | D1 | yours |
| Wiki pages and revisions | D1 | yours |
| Agent sessions, leases, file claims | D1 | yours |
| Auth sessions, OAuth state, caches | KV | yours |
| Attachments | R2 | yours |
| Rate-limit counters, live-update connections | Durable Objects | yours |
| MCP tool-call metrics (optional) | Analytics Engine | yours |

## What leaves the Worker

- **Your own Cloudflare Access signing keys.** To verify who is signed in, the Worker
  fetches the keys from your own Access tenant
  ([`middleware/auth.ts`](https://github.com/TAJD/projektor/blob/main/apps/api/src/middleware/auth.ts)).
- **Link previews.** When an issue or wiki page links to an external http(s) page, the
  Worker fetches that page to read its title, description and image for the preview
  card, and caches the result for a day. Only public hosts on default ports are fetched
  ([`services/link-previews.ts`](https://github.com/TAJD/projektor/blob/main/apps/api/src/services/link-previews.ts)).
  The site you link to sees a request from your Worker, not from the reader's browser.
- **Your own MCP usage metrics, if you set them up.** With the optional Analytics Engine
  dataset configured, `get_tool_usage` reads it back through the Cloudflare API, using a
  token you supply ([deploying](/projektor/guides/deploying/)).
- **Cloudflare's own platform logs and metrics.** Cloudflare operates the Worker, so it
  sees request metadata the way any infrastructure provider does. That is governed by
  your Cloudflare settings. Projektor does not add a second vendor.

The [feedback widget](/projektor/guides/feedback-widget-integration/) works the other
way round: your sites send feedback in to Projektor, and Projektor sends nothing out.

## Agents and models

Projektor doesn't host any models or call them as part of its own workflow. Tool calls
arrive over MCP from an agent you run, and whatever that agent's model provider sees is
between you and that provider. Projektor sends no ticket, comment or wiki page anywhere
for training, embedding or summarising.

## Who can read it

Access is governed by your Cloudflare Access tenant and your Projektor workspace roles.
Every OAuth grant is bound to exactly one workspace by its RFC 8707 `resource` parameter.
See [connecting an agent](/projektor/agents/mcp-connection/) for the flow.

## What this is not

This page describes an architecture, not a compliance certification. You are the data
controller for your own instance. What you owe the people using it is between you and
them, and not something Projektor can settle on your behalf.
