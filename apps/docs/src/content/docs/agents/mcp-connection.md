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

The bootstrap endpoint is enabled only when `ENVIRONMENT=development` — any other value, including an unset one, disables it. It is idempotent, so it's safe to call more than once.

---

## 3. Manual connect (production)

Mint a token from the UI (Settings → Tokens) or via the API, then add the MCP server:

```bash
claude mcp add projektor \
  "https://<your-worker>.workers.dev/mcp/<workspace-uuid>" \
  --transport http \
  --header "Authorization: Bearer pk_<64 hex chars>" \
  --header "X-Workspace-Slug: <slug>"
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

`scopes` is a list of `"read"`, `"write"`, or `"*"` (full access) — e.g. `["read"]`, `["read", "write"]`, or `["*"]`. `expiresAt` is optional (unix seconds).

Token minting is one of a handful of REST-only endpoints — see [REST endpoints](/projektor/agents/rest-endpoints/) for the full list.

---

## 3b. Connect the Claude app

The Claude app (desktop, web at claude.ai, and mobile) doesn't use the `claude mcp add` CLI command — it connects to remote MCP servers through **Connectors** in Settings.

**Add it by URL and sign in.** No token to mint, paste, or rotate.

1. **Free / Pro / Max plans:** go to **Settings → Connectors** and click **"Add custom connector."**
   **Team / Enterprise plans:** an owner adds it once for the org via **Admin settings → Connectors → Add custom connector**; members then connect to it from **Settings → Connectors**.
2. **Server URL:** paste `https://<your-worker>.workers.dev/mcp/<workspace-uuid>` — the same URL shape used in §3, with the workspace UUID (not the slug) in the path. Leave the request-headers section empty.
3. Click **Add**. Claude discovers that the endpoint needs authorization, opens projektor's sign-in, and shows a consent screen naming **the workspace, your identity, and the permissions being granted**.
4. Approve. Claude receives its own credential; tools become available in a conversation.

Each person who connects gets their own grant. It is scoped to one workspace, it can never exceed the role that person holds there, and if they leave the workspace it stops working on the next request with nothing to clean up.

### Scopes

| Scope | What it allows |
| --- | --- |
| `projektor:read` | Read issues, wiki pages, projects and comments |
| `projektor:write` | Create and change issues, wiki pages, projects and comments |

A connector that requests no scopes is granted both. Your workspace role is still the ceiling: a `viewer` who grants `projektor:write` gets a connector that can read, because the service layer checks the role on every call.

### Reviewing and withdrawing access

**Settings → API Tokens → Connected applications** lists the connectors you have authorized for the workspace, and disconnects any of them. Revocation takes effect on the next request — nothing is cached that would keep a withdrawn connector alive. Claude reports it as "authentication required" and offers to reconnect, rather than failing silently.

A grant expires 30 days after it is issued, shown in the **Expires** column. Reconnecting from Claude issues a fresh one; there is nothing to rotate in the meantime.

The list is yours alone. Unlike API tokens, which are workspace property and managed by admins, a connector grant is a personal credential: no one else can see or revoke yours, and you cannot see theirs.

### Fallback: a pasted API token

If your projektor instance predates OAuth support, or the connector fails to discover the authorization server, you can still connect with a `pk_` token in a request header.

1. Mint a token via **Settings → Tokens → "New token"**, as in [§1](#1-prerequisites) / [§3](#3-manual-connect-production).
2. In the connector dialog, open **Request headers** and add `Authorization` → `Bearer pk_<64 hex chars>` (enter the scheme yourself — Claude sends the value verbatim, it does not prepend `Bearer`).
3. **No `X-Workspace-Slug` needed.** The MCP endpoint resolves the workspace from the UUID already in the URL path.
4. If the instance is behind Cloudflare Access, also add `CF-Access-Client-Id` / `CF-Access-Client-Secret` as described in [§7](#7-cloudflare-access-note).

:::caution
**This is a worse credential than the OAuth flow, not merely a less convenient one.** Request headers on a connector are a beta feature, and on Team/Enterprise plans they are set by an org admin and **shared by everyone in the organisation** — one credential for the whole org, not one per person. That means no per-user attribution, and no way to withdraw one person's access without withdrawing everyone's. Prefer the sign-in flow above wherever the instance supports it.

Header *names* are also restricted to an allowlist (`authorization`, `x-api-key`, `x-auth-token`, and similar standard names). `Authorization` is allowlisted. The `CF-Access-Client-*` names are not, and may be rejected unless Anthropic has added them for your organization — if the connector fails with a `403` on an Access-protected instance, use the Claude Code CLI path (§2/§3) instead, which sends arbitrary headers with no such restriction.
:::

### For operators

The connector flow needs three things in the Worker configuration; a deployment missing any of them will still serve `pk_` tokens but cannot complete a sign-in. See the [deployment guide](/projektor/guides/deploying/) for the full setup.

- An `OAUTH_KV` namespace binding. The name is fixed and cannot be changed.
- `/.well-known/*` routed to the Worker ahead of static assets. Without it the discovery documents return the site's HTML shell, and the client reads a `200` as a valid document rather than as a failure.
- The `global_fetch_strictly_public` and `cache_option_enabled` compatibility flags.

If the instance sits behind **Cloudflare Access**, two paths must bypass the Access policy or the flow cannot start:

- `/.well-known/*` — discovery is unauthenticated by specification. Behind Access it answers `302` to a login page, and the client reports that the authorization server never received any traffic. This is the single most common way the connector fails to appear at all.
- `/oauth/token` — the client exchanges its authorization code here with no browser session to present.

`/oauth/authorize` must stay **behind** Access: that redirect is what signs the user in before the consent screen decides anything.

---

## 4. Verify the connection

**1. Confirm the server is registered:**

```bash
claude mcp list
# projektor should appear in the list
```

**2. Raw JSON-RPC smoke test** — exercises auth + workspace headers end-to-end, no agent required:

```bash
curl -s https://<your-worker>.workers.dev/mcp/<workspace-uuid> \
  -H "Authorization: Bearer pk_..." \
  -H "X-Workspace-Slug: <slug>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**3. Inside a Claude Code session:** run `/mcp` to confirm connection status, then give it a natural-language check — e.g. "list issues in PROJ".

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

If your projektor instance is behind Cloudflare Access (which it should be in production), headless agents need a **service token** rather than a user JWT. See the [Cloudflare Access docs on service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) for minting one.

Pass the service token credentials alongside the API token:

```bash
claude mcp add projektor \
  "https://<your-worker>.workers.dev/mcp/<workspace-uuid>" \
  --transport http \
  --header "Authorization: Bearer pk_<token>" \
  --header "X-Workspace-Slug: <slug>" \
  --header "CF-Access-Client-Id: <client-id>" \
  --header "CF-Access-Client-Secret: <client-secret>"
```

Without a valid CF Access service token, the Worker returns a `403` before it reaches the MCP layer — the agent connection fails silently. The bootstrap flow bypasses Access; agent workflows in production need both headers.

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
| `X-Workspace-Slug` | `<slug>` (optional on the MCP route — see below) |

The token is workspace-scoped — a token from workspace A is rejected for workspace B.

`X-Workspace-Slug` is **optional for `POST /mcp/<workspaceId>`**: when it's absent, the
workspace is resolved from the UUID in the path, so a client can connect with only the
`Authorization` header. Every other endpoint still requires it. The
token-workspace scope check is unchanged either way — it, not the header, is the security
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

These are the load-bearing shapes the Worker enforces — verified against the source:

- **MCP URL shape:** `POST /mcp/<workspaceId>` — UUID in the path, slug only in the header.
- **Required headers:** `Authorization` is always required. `X-Workspace-Slug` is required on every non-MCP endpoint; on `POST /mcp/<workspaceId>` it is optional because the path UUID resolves the workspace.
- **Token prefix:** `pk_` (64 hex chars); verified via SHA-256 hash lookup against D1.
- **CORS:** both headers are in the Worker's explicit `allowHeaders` list.
