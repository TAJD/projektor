---
title: "Connect Claude and other MCP clients to Projektor"
description: "Connect the Claude app, Claude Code or any MCP client to your Projektor instance: OAuth sign-in first, API tokens for headless agents."
sidebar:
  label: "Connect Claude"
  order: 1
---
This is the one page for connecting an agent to Projektor. Every other page links here.

**You need one thing:** your workspace's **server URL**. In Projektor, open **Connect Agent**
in the sidebar and copy it. It looks like this, with the workspace UUID (not the slug) at
the end:

```text
https://<your-host>/mcp/<workspace-id>
```

## Which credential when

- **Sign-in (OAuth)**: for the Claude app, claude.ai, and Claude Code on your own machine.
  Any member creates one by approving a consent screen. Each person gets their own grant,
  capped by their workspace role.
- **Workspace API token** (`pk_…`): for headless agents, CI and scripts, where no one is
  there to sign in. A workspace admin or owner creates it from a signed-in browser session.
- **Cloudflare Access service token**: sent *alongside* an API token when the instance is
  behind Cloudflare Access. It gets the request through Access; it is not a Projektor
  credential. Whoever administers your Cloudflare Zero Trust account creates it.

Personal access tokens (`POST /auth/tokens`) also exist, but they are a human-only action
(see [Tokens](#tokens)). Agents cannot mint any kind of token.

## 1. Claude app or claude.ai (sign-in)

1. In Claude, open the **Connectors** settings and click **Add custom connector**. On a
   Team or Enterprise plan, an owner adds it once for the organization, and members then
   click **Connect** on it.
2. Paste the server URL. Leave the advanced settings empty, then click **Add**.
3. Claude opens Projektor's sign-in. Approve the consent screen, which names the
   workspace, your identity and the permissions being granted.
4. In a chat, enable the connector from the **+** menu → **Connectors**.

The Claude-side steps follow Anthropic's
[custom connectors guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
(custom connectors need a Pro, Max, Team or Enterprise plan). The connector works in
Claude Desktop too.

Your grant is scoped to one workspace and can never exceed your role there. If you leave
the workspace, it stops working on the next request. It lasts 30 days, and reconnecting
issues a fresh one. To review or withdraw it, see the **Connected applications** list on
the **Connect Agent** page. The list shows only your own grants; no one else can see or
revoke them.

| Scope | What it allows |
| --- | --- |
| `projektor:read` | Read issues, wiki pages, projects and comments |
| `projektor:write` | Create and change issues, wiki pages, projects and comments |

A connector that requests no scopes is granted both. Your role is still the ceiling: a
`viewer` who grants `projektor:write` can only read.

## 2. Claude Code

**Sign in (recommended on your own machine):**

```bash
claude mcp add --transport http projektor "https://<your-host>/mcp/<workspace-id>"
```

Then start `claude`, run `/mcp`, pick `projektor` and follow the sign-in in your browser.
Until you do, `claude mcp list` shows `projektor … ! Needs authentication`.

**With a workspace API token (headless):**

```bash
claude mcp add --transport http projektor "https://<your-host>/mcp/<workspace-id>" \
  --header "Authorization: Bearer pk_<token>"
```

Put the server name and URL **before** `--header`. `--header` takes several values, so on
current Claude Code a command that puts the headers first fails with
`error: missing required argument 'name'`. If you write the headers first, end them with
`--` (`claude mcp add --transport http --header "…" -- projektor "<url>"`), which is the
form the token dialog and `/bootstrap` print.

`X-Workspace-Slug` is optional on the MCP endpoint, because the UUID in the URL already
names the workspace.

The server is added for the current project only. Add `--scope user` to use it in every
project, or `--scope project` to write a shared [`.mcp.json`](#project-mcpjson-claude-code-shared-with-your-team).

## 3. Copy-paste configs

For Claude Code on the command line, see [§2](#2-claude-code). Every config below uses
the same server URL from **Connect Agent**: replace `<your-host>` and `<workspace-id>`.
Keep tokens out of files you commit; the token configs read them from the environment.

### Project `.mcp.json` (Claude Code, shared with your team)

Commit this at the repository root. Sign-in, with nothing secret in the file:

```json
{
  "mcpServers": {
    "projektor": {
      "type": "http",
      "url": "https://<your-host>/mcp/<workspace-id>"
    }
  }
}
```

With a token, read from each person's environment:

```json
{
  "mcpServers": {
    "projektor": {
      "type": "http",
      "url": "https://<your-host>/mcp/<workspace-id>",
      "headers": {
        "Authorization": "Bearer ${PROJEKTOR_TOKEN}"
      }
    }
  }
}
```

Claude Code asks once per project before it trusts servers from `.mcp.json`.

### Claude Desktop

Use the connector from [§1](#1-claude-app-or-claudeai-sign-in): it is the same feature
in the desktop app, and it needs no config file. If you must use a token instead (for
example on a plan without custom connectors), `claude_desktop_config.json` only starts
local programs, so bridge to the remote server with
[`mcp-remote`](https://github.com/geelen/mcp-remote):

```json
{
  "mcpServers": {
    "projektor": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-host>/mcp/<workspace-id>",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer pk_<token>" }
    }
  }
}
```

The file lives at `~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. There is no space
after `Authorization:`, because Claude Desktop on Windows mangles spaces in `args`; the
space goes in the `env` value instead (mcp-remote's documented workaround). This file
holds the token in plain text.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "projektor": {
      "url": "https://<your-host>/mcp/<workspace-id>",
      "headers": {
        "Authorization": "Bearer ${env:PROJEKTOR_TOKEN}"
      }
    }
  }
}
```

Cursor's sign-in with Projektor is untested: Projektor registers clients through
Client ID Metadata Documents, not dynamic client registration, so use a token here.

### Any other MCP client

Projektor speaks MCP over Streamable HTTP (JSON-RPC 2.0 over `POST`, no SSE). Any client
that supports remote HTTP servers works: give it the server URL, and either let it run
the OAuth sign-in or send `Authorization: Bearer pk_<token>`.

**How these were checked:** the Claude Code commands, both `.mcp.json` files and the
`mcp-remote` bridge were run against a local instance (`claude mcp list` → `Connected`, or
`Needs authentication` before sign-in; `mcp-remote` returned the tool list). The
Claude Desktop and Cursor file formats follow those clients' own docs
([Claude Code MCP](https://code.claude.com/docs/en/mcp), [mcp-remote](https://github.com/geelen/mcp-remote),
[Cursor MCP](https://cursor.com/docs/context/mcp)) and were not loaded in the apps themselves.

## 4. Behind Cloudflare Access (headless agents)

A browser session gets through Access by logging in. A headless agent can't, so it sends
a Cloudflare Access [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
alongside its API token:

```bash
claude mcp add --transport http projektor "https://<your-host>/mcp/<workspace-id>" \
  --header "Authorization: Bearer pk_<token>" \
  --header "CF-Access-Client-Id: <client-id>" \
  --header "CF-Access-Client-Secret: <client-secret>"
```

:::caution[Unverified: may return 401 today]
Cloudflare Access forwards a service-token JWT to the Worker, and that JWT has no email.
Since v0.6.15, Projektor rejects such a JWT before it checks the `Authorization` header.
This combination has not been re-tested against a live Access instance; it is tracked in
PROJ-979. If you get `401 {"error":"Invalid Access token"}`, that is the cause.
:::

The sign-in flow needs no service token, but the operator must exempt two OAuth paths
from Access first. See [For operators](#for-operators).

## Verify it worked

1. `claude mcp list` should print `projektor: https://<your-host>/mcp/<workspace-id> (HTTP) - √ Connected`.
2. Without any agent, this request should return `200` with `"serverInfo":{"name":"projektor",…}`:

   ```bash
   curl -s -X POST "https://<your-host>/mcp/<workspace-id>" \
     -H "Authorization: Bearer pk_<token>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
   ```

3. In Claude, ask: "List the projects in this workspace."

## If it doesn't work

**`404 {"error":"Workspace not found"}`** (Claude Code: `MCP endpoint not found`). The URL
holds the workspace slug, or a UUID that doesn't exist. Copy the server URL from
**Connect Agent**; the path takes the UUID.

**`401 {"error":"Unauthorized"}`** (Claude Code: `Server rejected the configured
Authorization header (HTTP 401)`). The token is wrong, revoked or expired, or the `Bearer `
prefix is missing. Get a new token from an admin, and send it as
`Authorization: Bearer pk_…`.

**`403 {"error":"Forbidden"}`**. The token belongs to a different workspace: a workspace
token works only in the workspace it was created in. You also get a 403 if you are not a
member of this workspace. Use the server URL of the token's own workspace, or create a
token in this one.

**The connector never shows a sign-in, or discovery returns `302`.** Cloudflare Access is
answering the OAuth discovery request with a login redirect. The operator adds the
[Access carve-outs](#for-operators).

## Tokens

**Workspace API tokens** (the `pk_` kind, for agents) are made on the **Connect Agent** page
under **API tokens — admins only** → **+ New token**. Pick a name, **Read + Write** or
**Read-only**, and an optional expiry in days. The token is shown once. The REST route
behind that dialog is `POST /api/workspaces/<slug>/tokens`, with a body like
`{"name": "ci-agent", "scopes": ["read", "write"], "expiresInDays": 90}`. It returns
`{"id", "token": "pk_<64 hex chars>", "name", "scopes", "expiresAt"}`. `scopes` takes
`"read"`, `"write"` or `"*"`; `expiresInDays` is 1 to 365, or leave it out for no expiry.

Creating or revoking a token requires a **signed-in browser session** as a workspace admin
or owner. A request made with an API token or an OAuth grant gets `403` ("Workspace
tokens can only be created or revoked from a signed-in browser session…"), so an agent
can never mint a sibling credential (PROJ-917). Listing tokens (`GET`) works with any
admin credential, since it returns no secrets.

**Personal access tokens** (`POST /auth/tokens`) follow the same rule: signed-in browser
sessions only, and they are not offered in the UI (PROJ-903). They have **no** `pk_` prefix: the response is `{"token": "<72 characters: two UUIDs run together>"}`.
Agents should use a workspace token or the sign-in flow instead.

## For operators

The sign-in flow needs three things in the Worker configuration. Without them, the
instance still serves `pk_` tokens but cannot complete a sign-in. Details are in the
[deployment guide](/projektor/guides/deploying/).

- An `OAUTH_KV` namespace binding. The name is fixed.
- `/.well-known/*` in `run_worker_first`, so discovery reaches the Worker instead of the
  site's HTML shell.
- The `global_fetch_strictly_public` and `cache_option_enabled` compatibility flags.

Behind Cloudflare Access, `/.well-known/*` and `/oauth/token` must **bypass** Access, and
`/oauth/authorize` must stay **protected**: see
[Deploying → Cloudflare Access carve-outs for OAuth](/projektor/guides/deploying/#6-cloudflare-access-carve-outs-for-oauth).

:::note[One-click deploy: no sign-in yet]
The [Deploy to Cloudflare button](https://github.com/TAJD/projektor-deploy-example) and
its `deploy-auto.sh` currently pin Projektor **v0.3.7**, which predates sign-in (added in
v0.6.1). Their generated config also has no
`OAUTH_KV` binding, no `/.well-known/*` in `run_worker_first` and neither OAuth
compatibility flag. On an instance deployed that way, connect with a workspace API token
([§2](#2-claude-code)) until the deploy repo is updated, or follow the
[manual deploy](/projektor/guides/deploying/), which ships the full config.
:::

## Local development

`GET /bootstrap` seeds a workspace, a user and a `pk_` token on a local stack (only when
`ENVIRONMENT=development` and `BOOTSTRAP_SECRET` is set; see `AGENTS.md` → *Dev workflow*):

```bash
curl -s http://127.0.0.1:8787/bootstrap -H "X-Bootstrap-Secret: localdev"
```

The response has `workspace.id`, `token`, `mcpUrl` and a ready-to-run `mcpAddCommand`.

The local sign-in flow needs a real browser: the dev auth bypass is deliberately off on
`/mcp/`, so an unauthenticated MCP request gets the `401` challenge that starts OAuth.

## Next

- Every tool, generated from source: [MCP tool catalog](/projektor/agents/tool-catalog/).
- What to ask for, and how agents coordinate: [Agentic workflows](/projektor/agents/agent-workflows/).

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
| `Authorization` | `Bearer pk_<64 hex chars>` (workspace token) or the OAuth access token Claude obtained |
| `X-Workspace-Slug` | `<slug>` (optional on the MCP route — see below) |

A workspace token or OAuth grant is confined to its workspace: used on another workspace's URL it gets `403`.

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

These hints are advisory only — projektor has no server-side cache backing them. If you
cache `tools/list` client-side, key on the full request URL (path + query string), not
the path alone: the list varies by `?domains=`, so a path-only cache key will serve a
stale or wrongly-filtered catalog.

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

#### Tool failures are results, not protocol errors

When a tool call fails (bad arguments, something not found, not allowed, a conflict), the
response is an ordinary JSON-RPC **result** with `isError: true`, so the model sees the
failure and can correct itself. The single text content item is JSON:

```json
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "isError": true,
    "content": [{ "type": "text", "text": "{\"error\":{\"code\":\"not_found\",\"message\":\"Issue not found\",\"hint\":\"Refs look like PROJ-42 (project key + number). Use search_issues to find one.\"}}" }]
  }
}
```

| Field | Meaning |
|-------|---------|
| `code` | One of `validation`, `not_found`, `forbidden`, `conflict`, `payload_too_large`, `rate_limited` |
| `message` | What went wrong, in plain words |
| `fields` | `validation` only: the offending argument names, each with its problems |
| `hint` | A concrete next step (which tool finds the thing, which role is needed, how to recover from a conflict) |
| `details` | Structured extras a tool attaches, e.g. a wiki conflict's `currentRevisionId` and `diff`, or `patch_wiki_page`'s `currentHeadings` |

Each hint is a next step, not a restatement of the message: a `not_found` on an issue ref
names the ref format and `search_issues`; on a wiki page it names `search_wiki`; a
`validation` failure names the fields to fix; a `conflict` on a wiki save says to re-read
with `get_wiki_page` and apply the change with `patch_wiki_page`; `forbidden` says which
role is missing. `fields`, `hint` and `details` are omitted when they don't apply.

A call whose arguments fail the tool's input schema (a missing required argument, a wrong
type, an unknown parameter) is a `validation` tool error, checked before the tool runs.

#### JSON-RPC errors (protocol faults only)

A JSON-RPC `error` member is reserved for problems with the request itself, or an
unexpected internal failure:

| Code | Meaning |
|------|---------|
| `-32700` | Parse error (the body is not valid JSON) |
| `-32600` | Invalid Request (bad JSON-RPC envelope) |
| `-32601` | Method or tool not found |
| `-32602` | Invalid params on the envelope itself (a `tools/call` with no tool name, or `arguments` that is not an object) |
| `-32003` | Token lacks the required scope. This is an HTTP 403 with a `WWW-Authenticate` challenge, which lets an OAuth client offer a step-up; it is unchanged |
| `-32000` | Unexpected internal error, with only a request id in the message |

A client that treated every `error` as "the call failed" must also check `result.isError`.

### List results and the result cap

Every list tool returns `{"items": [...], "next": "…"}`; pass `next` back as `cursor` for
the next page. Long results from `list_issues`, `search_wiki`, `list_wiki_changes` and
`list_project_activity` are cut on an item boundary and flagged `truncated:true`. Issue tools take `view=summary|full` and `fields=`. See
[Response conventions](/projektor/agents/response-conventions/).

### Stable API contracts

These are the load-bearing shapes the Worker enforces — verified against the source:

- **MCP URL shape:** `POST /mcp/<workspaceId>` — UUID in the path, slug only in the header.
- **Required headers:** `Authorization` is always required. `X-Workspace-Slug` is required on every non-MCP endpoint; on `POST /mcp/<workspaceId>` it is optional because the path UUID resolves the workspace.
- **Token shape:** workspace tokens are `pk_` + 64 hex chars; personal access tokens have no prefix (two UUIDs run together, 72 characters). Both are verified by SHA-256 hash lookup against D1.
- **CORS:** both headers are in the Worker's explicit `allowHeaders` list.
