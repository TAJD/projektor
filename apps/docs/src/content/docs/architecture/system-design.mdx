---
title: "Architecture"
description: "How Projektor is put together: surfaces, service layer, and storage."
sidebar:
  order: 1
---
> Wiki + Jira-style issue tracker built MCP-native, running entirely on Cloudflare's edge.
> Monorepo (pnpm + turbo).

This page is an accurate map of how Projektor is actually built - its surfaces, the
service layer, and storage - and it stays honest about what is wired up versus what
isn't yet. It describes the real system as it stands today, not an idealised summary of it.

## How it works

Projektor runs as a **single Cloudflare Worker** (`apps/api`, built on Hono). That one
Worker exposes two surfaces over a shared request pipeline: a **REST API** for the
browser SPA, and an **MCP endpoint** (JSON-RPC 2.0) that is the primary, first-class
surface for AI agents. Every request flows through auth middleware - Cloudflare Access
JWTs for human browser sessions, hashed API tokens for agents - and then workspace
middleware that resolves the tenant from the slug and verifies membership before any
handler runs.

State lives entirely on Cloudflare's edge. **D1** (SQLite) holds the relational data -
workspaces, users, projects, issues, comments, wiki pages, tokens, activity, and
revisions. **KV** caches sessions, Access certs, and email lookups. **R2** is bound for
file attachments. There are no servers and no containers: the whole system deploys as a
Worker plus its bound data stores, which is what makes a five-minute self-host possible.

The sections below give the picture in increasing detail - first a diagram, then a
layer-by-layer breakdown, then the request flow through a single agent call.

## System diagram

```mermaid
flowchart TB
    subgraph Clients
        AI["AI agents<br/>(Claude, etc.)"]
        Browser["Browser / SPA user"]
        CI["GitHub Actions"]
    end

    subgraph Edge["Cloudflare Edge"]
        Access["Cloudflare Access<br/>(SSO / Zero Trust)"]
        subgraph Worker["projektor-api · Cloudflare Worker (Hono)"]
            direction TB
            MW["Middleware<br/>auth → workspace"]
            REST["REST routes<br/>/api/projects · issues · wiki · comments · workspaces"]
            MCP["MCP endpoint<br/>POST /mcp/:workspaceId<br/>(JSON-RPC 2.0)"]
            BOOT["/bootstrap · /health<br/>(dev convenience)"]
            REG["PluginRegistry<br/>(in-memory)"]
        end
        Pages["projektor-web<br/>(Astro + Preact SPA)"]
    end

    subgraph Storage["Cloudflare Data"]
        D1[("D1 / SQLite<br/>workspaces, users, projects,<br/>issues, comments, wiki, tokens,<br/>activity, revisions")]
        KV[("KV<br/>sessions, CF certs,<br/>user-by-email cache")]
        R2[("R2<br/>file attachments<br/>(upload / download API)")]
    end

    Plugins["plugins/github<br/>(defined, NOT wired in)"]

    AI -->|"Bearer token + X-Workspace-Slug"| MCP
    Browser -->|"CF_Authorization cookie"| Access --> REST
    Browser --> Pages
    CI -->|"release artifact"| Worker

    MW --> REST
    MW --> MCP
    MCP --> REG
    REST --> D1
    MCP --> D1
    MW --> D1
    MW --> KV
    REST --> R2
    REG -.->|"never registered"| Plugins

    classDef gap fill:#ffe0e0,stroke:#c00,color:#900;
    classDef stub fill:#fff5d6,stroke:#c90,color:#960;
    class Plugins gap;
    class BOOT stub;
```

## Layer breakdown

| Layer | Tech | Package | Notes |
|-------|------|---------|-------|
| Frontend | Astro + Preact | `apps/web` | Full SPA - issues, board, sprints, wiki, settings, tokens. Dev-proxies `/api` + `/mcp` to `:8787`. |
| API / edge runtime | Hono on Cloudflare Workers | `apps/api` | REST + MCP, two-mode auth, workspace tenancy. |
| MCP server | JSON-RPC 2.0 over HTTP | `apps/api/src/routes/mcp.ts` | 64 tools across 14 domains (coordination + project data). Primary surface. |
| Plugin system | Registry + SDK | `apps/api/src/plugins`, `packages/plugin-sdk` | `definePlugin` / `defineMCPTool`. **Not loaded at runtime.** |
| Data model | Drizzle ORM → D1 | `packages/db` | Drizzle is the query layer across the service modules; raw `c.env.DB.prepare` survives only in the dev bootstrap. |
| Shared types | TS | `packages/types` | `HonoEnv`, `Plugin`, `MCPTool`, `PluginContext`. |
| Auth | CF Access JWT (RS256) + API tokens (SHA-256) | `middleware/auth.ts` | Plus dev bypass via `DEV_USER_EMAIL`. |
| Deploy | wrangler + GitHub Actions | `projektor-deploy-example`, `projektor-workspace` | projektor publishes a release artifact; a config-only deploy repo downloads + ships it (no submodule). |

## Request flow

1. **Agent** → `POST /mcp/:workspaceId` with `Authorization: Bearer pk_…` + `X-Workspace-Slug`.
2. `authMiddleware`: CF Access JWT → API-token (KV session cache → D1 hash lookup) → dev bypass.
3. `workspaceMiddleware`: resolve slug → load workspace → verify `workspace_members` row.
4. MCP router dispatches `initialize` / `tools/list` / `tools/call` → core tool handler → D1.
