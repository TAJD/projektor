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
  - **Development** - use the bootstrap endpoint (see §2 below). No login required; needs `BOOTSTRAP_SECRET`.
  - **Production** - log in through the UI → Settings → Tokens → "New token"; or mint one via the REST API (see §3).

Using the Claude Code CLI? Continue to §2/§3 below. Using the Claude app (desktop or web) instead? Skip to [§3b. Connect the Claude app](#3b-connect-the-claude-app).

---

## 2. One-shot connect (dev / bootstrap)

The bootstrap endpoint provisions a workspace, user, and token in a single call, then prints the exact `claude mcp add` command to run. Use this for local dev or staging environments where `BOOTSTRAP_SECRET` is set.

```bash
# 1. Bootstrap workspace + token
curl -s "https://<your-worker>.workers.dev/bootstrap" \
  -H "X-Bootstrap-Secret: <your-secret>"

# Response includes mcpAddCommand - pipe it straight to your shell:
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

The bootstrap endpoint is enabled only when `ENVIRONMENT=development` - any other value, including an unset one, disables it. It is idempotent, so it's safe to call more than once.

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

`scopes` is a list of `"read"`, `"write"`, or `"*"` (full access) - e.g. `["read"]`, `["read", "write"]`, or `["*"]`. `expiresAt` is optional (unix seconds).

Token minting is one of a handful of REST-only endpoints - see [REST endpoints](/projektor/agents/rest-endpoints/) for the full list.

---

## 3b. Connect the Claude app

The Claude app (desktop and web, at claude.ai) doesn't use the `claude mcp add` CLI command - it connects to remote MCP servers through **Connectors** in Settings.

1. **Free / Pro / Max plans:** go to **Settings → Connectors** and click **"Add custom connector."**
   **Team / Enterprise plans:** an owner adds it once for the org via **Admin settings → Connectors → Add custom connector**; members then connect to it from **Settings → Connectors**.
2. **Server URL:** paste `https://<your-worker>.workers.dev/mcp/<workspace-uuid>` - the same URL shape used in §3, with the workspace UUID (not the slug) in the path.
3. **Headers:** open the **Request headers** section of the dialog and add:
   - `Authorization` → `Bearer pk_<64 hex chars>` (enter the scheme yourself - Claude sends the value verbatim, it does not prepend `Bearer`).
   - **No `X-Workspace-Slug` needed.** The MCP endpoint resolves the workspace from the UUID already in the server URL's path, so the app connects with the `Authorization` header alone. The token stays workspace-scoped - a token minted for another workspace is still rejected regardless of the path.
   - If the instance is behind Cloudflare Access, also add `CF-Access-Client-Id` / `CF-Access-Client-Secret` as described in [§7](#7-cloudflare-access-note).
4. Click **Add**. Claude calls `initialize` against the URL to confirm the connection before tools become available in a conversation.

For minting the `pk_...` token itself, use the same Settings → Tokens → "New token" flow described in [§1](#1-prerequisites) / [§3](#3-manual-connect-production) - there's nothing app-specific about token creation.

:::caution
**Request headers are a beta feature**, rolled out gradually - if you don't see a **Request headers** section in the dialog, contact Anthropic to request access.

Header *names* are restricted to an allowlist (`authorization`, `x-api-key`, `x-auth-token`, and similar standard names) - Claude rejects arbitrary custom header names for security reasons. `Authorization` is allowlisted, so the standard connection works out of the box. The one exception is a Cloudflare Access-protected instance: the `CF-Access-Client-*` header names are non-standard and may be rejected unless Anthropic has added them to the allowlist for your organization. If the connector fails with a `403` on such an instance, ask your Anthropic representative to allowlist those two headers, or use the Claude Code CLI path (§2/§3) instead, which sends arbitrary headers with no such restriction.
:::

---

## 4. Verify the connection

**1. Confirm the server is registered:**

```bash
claude mcp list
# projektor should appear in the list
```

**2. Raw JSON-RPC smoke test** - exercises auth + workspace headers end-to-end, no agent required:

```bash
curl -s https://<your-worker>.workers.dev/mcp/<workspace-uuid> \
  -H "Authorization: Bearer pk_..." \
  -H "X-Workspace-Slug: <slug>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**3. Inside a Claude Code session:** run `/mcp` to confirm connection status, then give it a natural-language check - e.g. "list issues in PROJ".

---

## 5. Tool catalog

The complete, always-current catalog is **generated from source** - every tool,
grouped by domain, rendered from `apps/api/src/mcp/*.ts`:

➡️ **[MCP tool catalog](/projektor/agents/tool-catalog/)** (on the docs site: *Agents & MCP → MCP tool catalog*).

It is regenerated and freshness-checked by CI, so it can never drift from the code.
This guide intentionally does **not** repeat the table - there is one source of truth.

---

## 6. Common agent workflows

Once connected, give Claude Code natural-language instructions:

**Create and triage issues**
> "Create a ticket for fixing the login redirect in the PROJ project - high priority, assign it to me."

**Query and summarise work**
> "Show me all open issues in PROJ, grouped by status."
> "What are the highest-priority issues I should work on next?"

**Sprint planning**
> "Create a sprint called 'Week 24' in PROJ, then move all in-progress and high-priority backlog issues into it."
> "Mark the current sprint complete and show me what's left unfinished."

**Wiki writing**
> "Write a wiki page summarising what we shipped in this sprint - use the completed issues as your source."
> "Search the wiki for 'auth flow' and show me what we've documented."

**Member management**
> "List workspace members and their roles."
> "Invite user@example.com as a member."

**Cross-issue work**
> "Find all issues blocked by PROJ-12 and summarise what's at risk."

---

## 7. Cloudflare Access note

If your projektor instance is behind Cloudflare Access (which it should be in production), headless agents need a **service token** rather than a user JWT. See the [Cloudflare Access docs on service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) for minting one.

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

Without a valid CF Access service token, the Worker returns a `403` before it reaches the MCP layer - the agent connection fails silently. The bootstrap flow bypasses Access; agent workflows in production need both headers.

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
| `X-Workspace-Slug` | `<slug>` (optional on the MCP route - see below) |

The token is workspace-scoped - a token from workspace A is rejected for workspace B.

`X-Workspace-Slug` is **optional for `POST /mcp/<workspaceId>`**: when it's absent, the
workspace is resolved from the UUID in the path, so a client can connect with only the
`Authorization` header. Every other endpoint still requires it. The
token-workspace scope check is unchanged either way - it, not the header, is the security
boundary.

### initialize

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "projektor", "version": "<the deployed release's version, e.g. from its git tag>" },
    "instructions": "<one-paragraph pointer to get_workflow>"
  }
}
```

`protocolVersion` is `"2025-11-25"` — the latest protocol revision that still uses this
`initialize` handshake. The 2026-07-28 spec introduced a "modern" era with no `initialize`
method at all (version + identity travel per-request in `_meta` instead); projektor hasn't
adopted that yet, so it doesn't claim the `"2026-07-28"` version string here.

### tools/list

`tools/list` results also carry cache hints per the 2026-07-28 spec (SEP-2549):

```json
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "tools": [ /* ... */ ],
    "ttlMs": 60000,
    "cacheScope": "private"
  }
}
```

`cacheScope` follows HTTP `Cache-Control` semantics (`"private"` here, since the list
isn't currently filtered per-caller, but isn't safe for a shared/intermediary cache to
serve across different callers either).

### tools/call

```json
{
  "jsonrpc": "2.0", "id": 3,
  "method": "tools/call",
  "params": { "name": "get_issue", "arguments": { "ref": "PROJ-1" } }
}
```

Error codes: `-32600` invalid request, `-32601` method/tool not found, `-32602` validation error, `-32003` token lacks required scope, `-32000` other (not found, forbidden, conflict).

| Code | Meaning |
|------|---------|
| `-32600` | Invalid Request (bad JSON-RPC envelope) |
| `-32601` | Method or tool not found |
| `-32602` | Validation error (invalid params) |
| `-32003` | Token lacks the required scope |
| `-32000` | Other (not found, forbidden, conflict) |

Errors carrying structured detail beyond the message also set the JSON-RPC 2.0
`error.data` member — e.g. a `-32602` from a validation failure sets `data` to the
Zod-flattened issues (`formErrors`/`fieldErrors`), and a `-32000` conflict or
not-found error sets `data` to its detail payload (e.g. `currentRevisionId`/`diff`,
or `currentHeadings`). `data` is omitted entirely when an error has no structured
detail beyond its message.

### Stable API contracts

These are the load-bearing shapes the Worker enforces - verified against the source:

- **MCP URL shape:** `POST /mcp/<workspaceId>` - UUID in the path, slug only in the header.
- **Required headers:** `Authorization` is always required. `X-Workspace-Slug` is required on every non-MCP endpoint; on `POST /mcp/<workspaceId>` it is optional because the path UUID resolves the workspace.
- **Token prefix:** `pk_` (64 hex chars); verified via SHA-256 hash lookup against D1.
- **CORS:** both headers are in the Worker's explicit `allowHeaders` list.
