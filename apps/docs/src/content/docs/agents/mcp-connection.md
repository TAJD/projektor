---
title: "Connect an AI agent"
description: "Connect Claude Code or any MCP-compatible agent to your Projektor instance."
sidebar:
  order: 1
---
Connect Claude Code (or any MCP-compatible agent) to your projektor instance.

---

## 1. Prerequisites

- **A running projektor instance.** See the [self-hosting guide](/projektor/guides/self-hosting/) or the full [deploy guide](/projektor/guides/deploying/).
- **Claude Code installed.** `npm install -g @anthropic-ai/claude-code` (or the desktop/IDE app).
- **A projektor API token.** Two ways to get one:
  - **Development** — use the bootstrap endpoint (see §2 below). No login required; needs `BOOTSTRAP_SECRET`.
  - **Production** — log in through the UI → Settings → Tokens → "New token"; or mint one via the REST API (see §3).

---

## 2. One-shot connect (dev / bootstrap)

The bootstrap endpoint provisions a workspace, user, and token in a single call, then prints the exact `claude mcp add` command to run. Use this for local dev or staging environments where `BOOTSTRAP_SECRET` is set.

```bash
# 1. Bootstrap workspace + token
curl -s "https://<your-worker>.workers.dev/bootstrap" \
  -H "X-Bootstrap-Secret: <your-secret>"

# Response includes mcpAddCommand — pipe it straight to your shell:
curl -s "https://<your-worker>.workers.dev/bootstrap" \
  -H "X-Bootstrap-Secret: <your-secret>" \
  | jq -r .mcpAddCommand | sh
```

Local dev (BOOTSTRAP_SECRET defaults to `localdev` in `.dev.vars.example`):

```bash
curl -s http://127.0.0.1:8787/bootstrap \
  -H "X-Bootstrap-Secret: localdev" \
  | jq -r .mcpAddCommand | sh
```

The bootstrap endpoint is disabled when `ENVIRONMENT=production`. It is safe to call multiple times — it is idempotent.

---

## 3. Manual connect (production)

Mint a token from the UI (Settings → Tokens) or via the API, then add the MCP server:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer pk_<64 hex chars>" \
  --header "X-Workspace-Slug: <slug>" \
  projektor \
  "https://<your-worker>.workers.dev/mcp/<workspace-uuid>"
```

**Finding the workspace ID:** it is returned by `GET /api/workspaces` or shown in the bootstrap response. The slug is the short identifier you chose when creating the workspace (e.g. `projektor`).

**Minting a token via REST** (requires a valid Cloudflare Access JWT):

```bash
curl -s -X POST "https://<your-worker>.workers.dev/auth/tokens" \
  -H "Authorization: Bearer <cf-access-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "workspaceId": "<workspace-uuid>",
    "scopes": ["read", "write"],
    "expiresAt": 1893456000
  }'
# Response: { "token": "pk_..." }
```

`scopes` must be `["read"]`, `["write"]`, or `["read", "write"]`. `expiresAt` is optional (unix seconds).

---

## 4. Verify the connection

```bash
# projektor should appear in the list
claude mcp list

# Smoke test — list issues (returns empty array if no issues yet)
claude mcp call projektor list_issues '{}'

# Get workspace membership
claude mcp call projektor list_members '{}'
```

---

## 5. Tool catalog

The complete, always-current catalog is **generated from source** — every tool,
grouped by domain, rendered from `apps/api/src/mcp/*.ts`:

➡️ **[MCP tool catalog](/projektor/agents/tool-catalog/)** (on the docs site: *Agents & MCP → MCP tool catalog*).

It is regenerated and freshness-checked by CI, so it can never drift from the code.
This guide intentionally does **not** repeat the table — there is one source of truth.

---

## 6. Common agent workflows

Once connected, give Claude Code natural-language instructions:

**Create and triage issues**
> "Create a ticket for fixing the login redirect in the PROJ project — high priority, assign it to me."

**Query and summarise work**
> "Show me all open issues in PROJ, grouped by status."  
> "What are the highest-priority issues I should work on next?"

**Sprint planning**
> "Create a sprint called 'Week 24' in PROJ, then move all in-progress and high-priority backlog issues into it."  
> "Mark the current sprint complete and show me what's left unfinished."

**Wiki writing**
> "Write a wiki page summarising what we shipped in this sprint — use the completed issues as your source."  
> "Search the wiki for 'auth flow' and show me what we've documented."

**Member management**
> "List workspace members and their roles."  
> "Invite user@example.com as a member."

**Cross-issue work**
> "Find all issues blocked by PROJ-12 and summarise what's at risk."

---

## 7. Cloudflare Access note

If your projektor instance is behind Cloudflare Access (which it should be in production), headless agents need a **service token** rather than a user JWT. See the CF Access docs for minting service tokens.

Pass the service token credentials alongside the API token:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer pk_<token>" \
  --header "X-Workspace-Slug: <slug>" \
  --header "CF-Access-Client-Id: <client-id>" \
  --header "CF-Access-Client-Secret: <client-secret>" \
  projektor \
  "https://<your-worker>.workers.dev/mcp/<workspace-uuid>"
```

Without a valid CF Access service token, the Worker will return a `403` before the MCP layer is reached — the agent connection will silently fail. The bootstrap flow bypasses Access; agent workflows in production need both headers. (Tracked in PROJ-129.)

---

## Protocol reference

### Endpoint

```
POST /mcp/<workspaceId>
Content-Type: application/json
```

**Transport:** MCP Streamable HTTP (JSON-RPC 2.0).  
**`<workspaceId>`** is the workspace UUID (not the slug). The bootstrap response and `GET /api/workspaces` both return it.

### Required headers

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer pk_<64 hex chars>` |
| `X-Workspace-Slug` | `<slug>` |

The token is workspace-scoped — a token from workspace A is rejected for workspace B.

### initialize

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "projektor", "version": "0.1.0" }
  }
}
```

### tools/call

```json
{
  "jsonrpc": "2.0", "id": 3,
  "method": "tools/call",
  "params": { "name": "get_issue", "arguments": { "ref": "PROJ-1" } }
}
```

Error codes: `-32600` invalid request, `-32601` method/tool not found, `-32602` validation error, `-32000` other (not found, forbidden, conflict).

### Stable API contracts

These are the load-bearing shapes the Worker enforces — verified against the source:

- **MCP URL shape:** `POST /mcp/<workspaceId>` — UUID in the path, slug only in the header.
- **Required headers:** both `Authorization` and `X-Workspace-Slug` must be present on every call.
- **Token prefix:** `pk_` (64 hex chars); verified via SHA-256 hash lookup against D1.
- **CORS:** both headers are in the Worker's explicit `allowHeaders` list.
