# MRTR, Tasks extension, subscriptions/listen: design for PROJ-458 / PROJ-460 / PROJ-461 / PROJ-474

Covers the four "Design:"/adoption tickets under the PROJ-451 epic. Builds on
[the phase-1-3 compliance work](./2026-07-29-mcp-2026-07-28-update-plan.md) (PROJ-452/454/456,
shipped in v0.4.16) and on primary-source spec pages fetched directly from
`modelcontextprotocol.io` (not the announcement blog post) for MRTR, the Tasks extension,
`subscriptions/listen`, and `server/discover`.

## Addendum: adopt the official SDK instead of hand-rolling all four features?

**This addendum reframes everything below it from "the plan" to "the documented fallback" —
SDK adoption is a *candidate* primary path, pending a spike (see Recommendation), not yet a
committed decision.** Prompted by a direct question from the repo owner:
if the official `@modelcontextprotocol/typescript-sdk` already implements MRTR, Tasks,
subscriptions, and the modern era correctly, why hand-roll all four ourselves?

### What was verified (not assumed)

Two rounds of source-level research against `github.com/modelcontextprotocol/typescript-sdk`
(not just docs/README) confirmed:

- **Workers-compatible, not Node-only.** `packages/server/src/server/streamableHttp.ts` /
  `createMcpHandler.ts` are `Request`/`Response`-native. Node support is the adapter
  (`toNodeHandler()`), not the primary path. A dedicated `shimsWorkerd.ts` runtime shim
  (selected via package.json export conditions) is first-party Cloudflare Workers support,
  with comments specifically about isolate warm-up vs. per-request billed CPU.
- **Handles the legacy/modern split already.** `createMcpHandler()` classifies each request and
  serves 2026-07-28 (`_meta`-envelope) traffic per-request via a single-exchange transport,
  falling back to a documented "stateless legacy idiom" for pre-2025-11-25 traffic — this is
  exactly PROJ-474's scope, done for us, and both paths are per-request (matches projektor's
  model, not a persistent-process assumption).
- **Ships `subscriptions/listen`'s wire protocol** (SSE, pluggable event bus) out of the box —
  but scope this precisely (see correction below): it removes the protocol/ack/SSE-framing
  work, not PROJ-461's actual open blockers.
- **Context injection is workable but not "clean" — corrected after Opus review.** The
  original draft here overstated this. `createMcpHandler()` returns
  `{ fetch: (request, options?: { authInfo?, parsedBody? }) => Promise<Response> }`, and
  `authInfo` is pass-through (the SDK doesn't populate or verify it) — but `authInfo` is a
  typed MCP `AuthInfo` shape (token/clientId/scopes), not a place to stuff Cloudflare bindings.
  projektor's `PluginContext` (`apps/api/src/routes/mcp.ts:93-101`) is built per-request from
  `c.env.DB/KV/R2` plus `workspaceId`/`role`/`authKind` — and `McpServerFactory`'s
  `requestInfo: Request` carries no `env` either. The realistic integration is calling
  `createMcpHandler()` **inside** the Hono route so its closure captures `c.env`, which means
  re-registering all tools and recompiling all input schemas on every single request — in
  direct tension with the `shimsWorkerd.ts` isolate-warm-up/per-request-CPU-billing comments
  cited approvingly above. **Whether the handler can be constructed once (module scope) and
  still receive per-request `env` some other way is the single most important open question
  for the spike below — not yet answered.**
- **Tool registration needs a real adapter, not "light adaptation" — corrected after Opus
  review.** Two claims in the original draft were wrong: (a) `MCPTool.inputSchema`
  (`packages/types/src/plugin.ts:6`) is hand-written JSON Schema (`Record<string, unknown>`)
  across all ~90 registered tools (e.g. `apps/api/src/mcp/issues.ts:20-80`), not Zod — moving to
  `registerTool`'s Zod/Standard-Schema expectation means converting or generating Zod schemas
  for all ~90 tools, a real body of mechanical work, not a few files. (b) projektor's tool
  handlers return raw domain objects (`Promise<unknown>`) — the `{ content: [{ type: "text",
  ... }] }` wrapping happens once, centrally, in the route (`mcp.ts:154-158`), not per-handler.
  So the SDK's expected handler return shape doesn't already match; an adapter would wrap each
  handler's raw result the same way the current route does. Neither of these is hard, but "20
  tool modules ... do not need to change" undersold the ~90-tool schema-conversion cost.
- **Mounting under Hono is trivial** — `fetch` is fetch-shaped and bindable:
  `return await handler.fetch(c.req.raw, { authInfo })` from inside the existing
  `router.post("/:workspaceId", ...)` route. No routing-ownership conflict. (This part holds up
  unchanged — the env-threading question above is about *what* gets constructed and *when*,
  not whether the fetch-handoff itself works.)

### Two real problems this doesn't wave away

1. **Error-code contract change (real incompatibility, not cosmetic).** Per the SDK's own
   error-handling docs, a `tools/call` handler cannot emit a custom top-level JSON-RPC error
   code — every thrown exception is caught and converted to `{ content, isError: true }`; only
   one special-case error type propagates as a real JSON-RPC error. projektor's `-32003`
   (token-scope denial) and `-32000` (not-found/forbidden/conflict) codes documented in
   `apps/docs/src/content/docs/agents/mcp-connection.md` have **no path to the wire** for
   `tools/call` under this SDK — they'd become `isError: true` tool-result text instead, which
   is a client-visible behavior change (any caller checking `error.code === -32003` specifically
   would break, not just ones reading error text). Separately, the SDK's own missing-tool case
   throws an error that resolves to `-32602` (Invalid Params), not `-32601` (Method Not Found)
   as projektor uses today. **The cost here was understated, not overstated, in the original
   draft**: 24 assertions across 11 test files check specific `-32xxx` codes (including
   `apps/api/src/test/errors.test.ts`, which tests `toMcpError` directly), plus the
   `mcp-connection.md:270-278` error-code table — all of those would need rewriting, not just
   the doc prose. **This needs an explicit human decision**: accept the behavior change (likely
   fine for actual MCP clients like Claude Code, which read error text/`isError` rather than
   branching on numeric codes — but is a real, documented, test-covered contract change) — or
   keep a thin pre-check layer in front of the SDK for the specific cases where a real JSON-RPC
   error is required. Given the test-count finding, the pre-check-shim option looks more
   attractive than it did in the first draft of this addendum.
2. **Package maturity — this is genuinely new, not battle-tested.** The 2026-07-28-tracking
   package (`@modelcontextprotocol/server`, the split-out v2 line) went stable (`2.0.0`) on
   2026-07-27 — one day before this research was done. The repo has 266 open issues and 235
   open PRs — active development, not abandoned, but high churn is the more likely read than
   "settled API." The older `@modelcontextprotocol/sdk` v1.x line (79 published versions) is
   the actually mature one, but doesn't cover 2026-07-28 at all. Bundle-size impact on Workers'
   CPU/isolate limits wasn't discoverable from registry metadata alone and would need a real
   local install + bundle-analysis pass before committing.

### Recommendation

**Corrected after Opus review**: none of this has been run yet — everything above is source
reading on GitHub, not a local install. Calling SDK adoption "the primary path" outright, while
this section simultaneously says to *wait* for the package to mature, was self-contradictory.
The accurate framing is: **a candidate primary path, pending a concrete, time-boxed spike** —
not a decision, and not "the plan" until the spike passes its exit test.

**Spike exit test** (target: ≤1 day of work; if it can't be answered in that time, that's
itself a signal to fall back, not to keep extending the spike):

1. Local install of `@modelcontextprotocol/server` v2 in a scratch branch.
2. Answer the env-threading question first (see correction above) — can `createMcpHandler()`
   be constructed once and still receive per-request `c.env`/`workspaceId`/`role`/`authKind`,
   or does it genuinely require per-request reconstruction? This determines whether the
   isolate-warmup concern is real or moot.
3. Wire exactly 3 real tools (`get_issue`, `list_issues`, one mutating tool e.g. `update_issue`)
   through hand-converted Zod schemas, mounted under the existing Hono route via
   `handler.fetch(c.req.raw, { authInfo })`.
4. Exercise one real auth-denial case (token lacking required scope) and confirm what actually
   reaches the wire — `isError: true` text, per the error-mapping finding above — and decide
   right there whether that's acceptable or whether a pre-check shim is needed for
   scope-denial specifically (given the 24-assertion/11-file test cost found above, leaning
   toward "shim" is reasonable going in).
5. Only if 1–4 land cleanly: re-evaluate package maturity (wait for a `2.0.x` patch or two)
   before proposing a production cutover, and only then would this collapse PROJ-458
   (MRTR)/PROJ-460 (Tasks)/PROJ-461 (subscriptions)/PROJ-474 (modern era) into one migration
   effort.
6. If the spike fails or stalls at any step, **the hand-rolled designs in the rest of this
   document remain the documented fallback** — nothing below this addendum is invalidated by
   pursuing the spike, only reordered.

**Reconciling with PROJ-461 below**: the SDK supplies the wire protocol (framing, ack,
SSE transport) for `subscriptions/listen`, but PROJ-461's actual open blockers — D1 has no
change-notification mechanism to produce events from, per-token authorization filtering of the
stream, and Cloudflare Workers' duration limits on a long-lived SSE response — are unaffected
by which library owns the wire format. Adopting the SDK narrows PROJ-461's scope; it doesn't
close it.

**Reconciling with PROJ-474 below**: that section's standalone recommendation ("leave in
backlog, unprioritized... don't schedule speculatively") was written assuming a hand-rolled
modern-era implementation, where the cost/benefit genuinely didn't justify scheduling it alone.
If the SDK spike above succeeds, PROJ-474 stops being a standalone speculative migration and
becomes a side effect of adopting the SDK for MRTR/Tasks/subscriptions — at that point the
"leave in backlog" recommendation no longer applies, since the modern era support comes free
with the same migration. If the spike fails, PROJ-474's original backlog/unprioritized
recommendation stands as written.

## Cross-cutting decision: these don't require the "modern" era

The single biggest design question across all three tickets is whether MRTR / Tasks /
subscriptions require adopting the 2026-07-28 "modern" per-request-`_meta` era (PROJ-474)
first, or can land on top of projektor's existing legacy `initialize`-based transport.

**Decision: they can land on legacy.** All three are capability-negotiated additions to the
JSON-RPC surface, not properties of the transport era itself:

- MRTR's `resultType: "input_required"` is a new shape a `tools/call` (or `prompts/get`,
  `resources/read`) response can take — legal in any era, since it's just a JSON-RPC result
  payload.
- The Tasks extension negotiates via a `capabilities` field. Legacy `initialize` already
  returns `capabilities: { tools: {} }` — this is exactly the object to add
  `io.modelcontextprotocol/tasks: {}` to. The client-side capability check in the spec is
  `_meta.io.modelcontextprotocol/clientCapabilities.extensions`, which is per-request and
  works identically regardless of which era the server negotiated at handshake time.
- `subscriptions/listen` is a JSON-RPC method like any other; it doesn't require
  `server/discover`.

This means PROJ-474 (modern era) is **not a blocker** for PROJ-458/460/461, and should be
re-scoped as independent, lower-priority work rather than a prerequisite. See its own section
below.

> **Correction (post-Opus-review):** the independence argument leans on per-request
> `_meta.io.modelcontextprotocol/clientCapabilities` parsing existing — that mechanism *is*
> the modern era's defining feature, and `mcp.ts` today discards `initialize` params entirely
> (there is no session to remember them in, so nothing reads per-call `_meta` yet). Building
> Tasks-capability negotiation means adding that parsing regardless, at which point a
> meaningful share of PROJ-474's stated cost is already paid. The two aren't fully
> independent — PROJ-460 implementation will de-risk part of PROJ-474, not avoid it entirely.

> **Cross-cutting caveat (post-Opus-review):** field/method names throughout this doc
> (`resultType`, `inputRequests`, `taskId`/`ttlMs`/`pollIntervalMs`, the Tasks status enum,
> `notifications/subscriptions/acknowledged`, `io.modelcontextprotocol/subscriptionId`, the
> empty-`resultType:"complete"` close signal) are drawn from spec prose fetched via WebFetch,
> not from reading `@modelcontextprotocol/typescript-sdk` v2 source. All of them — not just
> the MRTR fields called out below — need verification against the actual SDK type
> definitions before any implementation task is scoped, per the protocolVersion/cacheScope
> mistakes already made once in this epic (PROJ-452/454).

## PROJ-458: MRTR contract, piloted on the workflow review gate

### Contract

Add a discriminated `resultType` field to `tools/call` results. Today's result shape (a bare
`{ content: [...] }`) becomes the implicit `resultType: "complete"` case; `input_required`
is the new second case:

```json
{
  "resultType": "input_required",
  "requestState": "<opaque server string>",
  "inputRequests": [
    { "kind": "confirmation", "prompt": "Approve transition PROJ-42: in_review -> done?",
      "context": { "diffSummary": "..." } }
  ]
}
```

The client collects an `InputResponses` array from its user/agent and re-invokes
`tools/call` with the **same tool name**, the original `arguments`, plus
`requestState` and the responses. The tool handler resumes from where it paused rather than
re-running from scratch.

Only `tools/call`, `prompts/get`, and `resources/read` may return this shape per spec.
`mcp.ts` today implements exactly `initialize`, `tools/list`, and `tools/call` — no
`prompts/get` or `resources/read` handlers exist (confirmed against `apps/api/src/routes/mcp.ts`
and consistent with PROJ-461's note that projektor has no MCP `resources/` capability). So in
practice MRTR applies to `tools/call` only, not "matches the surface exactly" as an earlier
draft of this doc claimed.

**Also missing from the contract above**: `MCPTool.handler(input, ctx)` has no parameter for
`requestState` or prior `InputResponses` — every tool module's handler signature would need to
grow a resume channel, not just the `update_issue` handler used by the pilot below. That's a
shared-interface change across `apps/api/src/mcp/*.ts`, and "the tool handler resumes from
where it paused" is misleading for a stateless server with no in-flight execution to resume:
in practice the resumed call re-executes from the start up to the checkpoint, using
`requestState` to reconstruct where it left off rather than continuing a suspended call.

### `requestState` integrity

> **Revised after Opus review — the original version of this section was insecure.** Signing
> `requestState` only proves the *challenge* is genuine; it does nothing to authenticate the
> *verdict*. The original design had the `InputResponse` (the approve/reject answer) travel
> back unsigned in the same call, which means the same agent that received the gate could
> answer its own challenge with `approved: true` and resume — the gate would enforce nothing.
> It was also replayable: no nonce, and no server-side single-use check, so a captured
> `requestState` + a guessed/observed verdict shape could be reused within `expiresAt`.
> Also: `auth.ts`'s existing token hashing (`auth.ts:451`) is unkeyed `SHA-256`, not HMAC — "same
> pattern" was inaccurate; there is no HMAC usage anywhere in `apps/api/src` today, and no
> `MRTR_STATE_SECRET` binding exists in `packages/types/src/env.ts` yet.

Corrected design — the verdict must come from an independently authenticated human, not from
whichever caller happens to resume the `tools/call`:

1. `requestState` is still HMAC-SHA256-signed (`toolName`, `arguments` hash, `workspaceId`,
   `issueId`, `targetStatus`, a random `nonce`, `issuedAt`, `expiresAt`) using a new
   `MRTR_STATE_SECRET` Worker secret (needs adding to `packages/types/src/env.ts` and the
   deploy config, with a documented dev-fallback/rotation story — neither exists today).
2. The verdict itself cannot be supplied by the same caller that receives the challenge.
   Recording a verdict requires a **separate, human-authenticated action** — e.g. the existing
   UI review flow, or a new REST endpoint reachable only via a human Cloudflare Access session
   (not a bearer agent token) — which, given the `nonce`, mints a short-lived **single-use
   verdict token** and marks that `nonce` consumed (one KV row, `nonce -> {verdict, consumedAt}`,
   TTL'd to `expiresAt`).
3. The MRTR resume call presents `requestState` + the verdict token, not a self-reported
   boolean. The handler verifies the `requestState` signature/expiry, verifies the verdict
   token against the KV entry (single-use — reject on a second redemption attempt), and only
   then applies or rejects the transition. Reject with `-32003` (the scope-denial code
   `mcp.ts:148` already uses for authz failures — not `-32602`, which is for malformed input)
   if any check fails.

**This is no longer fully stateless** — the single-use KV entry is real server-side state,
tracking exactly one thing (has this nonce been redeemed), TTL'd and workspace-scoped. That's
an honest tradeoff, not an oversight: a review gate that can be defeated by the reviewee is not
a review gate. This KV usage is small and self-cleaning (TTL = `expiresAt`), and doesn't reopen
the broader session-state questions PROJ-452 closed.

### Pilot: Gated Transitions (PROJ-464)

> **Correction (post-Opus-review):** `get_workflow` returns a static markdown string
> (`apps/api/src/services/workflow-content.ts`), not machine-readable gate configuration — "the
> existing state-machine config" referenced below doesn't exist yet and would need to be built
> (a small structured table: which transitions require human review, per project/workspace).
> More importantly, per that same workflow doc, **In Review → Done is explicitly *not* gated
> today** — `needsAudit` is deliberately an after-the-fact human review, not a blocking
> checkpoint. Piloting Gated Transitions on that specific transition is therefore not just a
> mechanical swap of `needs_audit` for `input_required`; it's a deliberate policy reversal
> (blocking-before vs. auditing-after) that needs to be called out and agreed to separately,
> not smuggled in as an implementation detail of the MRTR pilot.

`update_issue` calls that cross a workflow human-review gate (once that gate config exists —
see correction above) return `input_required` instead of the current out-of-band
"needs_audit" flag pattern:

1. Agent calls `update_issue(status: "done")` on a gated transition.
2. Handler detects the gate, returns `input_required` with a diff summary
   (what changed, old→new status, any flagged fields) and a signed `requestState`.
3. Human reviews out-of-band (UI or a human-attended agent session), the *same tool call* is
   reissued with the human's verdict as an `InputResponse`.
4. Handler verifies `requestState`, applies the transition if approved, or returns a normal
   error result if rejected — either way the call terminates in one logical operation instead
   of today's "set status, hope a human notices `needs_audit`" pattern.

This directly replaces the `needs_audit` boolean's implicit-polling model with a synchronous
checkpoint, and gives Gated Transitions (PROJ-464) a concrete implementation path once this
ticket's design is approved.

## PROJ-460: Tasks extension modeling for long-running work

### Relationship to existing `agents.ts` / `flow-metrics.ts`

The Tasks extension (`io.modelcontextprotocol/tasks`) models a **single async operation**
triggered by one `tools/call` — it's the MCP-protocol-level answer to "this call will take a
while, here's a handle to poll." projektor's `agents.ts` models something different: a
**persistent worker identity** (registration, heartbeat, lease ownership) that outlives any
single tool call. These don't overlap as much as the original compliance plan worried:

- **Tasks extension**: per-call, protocol-native, disposable (has a `ttlMs`), no identity of
  its own beyond the call that created it.
- **`agents.ts`**: per-worker, projektor-native, long-lived across many calls and many tasks.

**Decision: Tasks sits *alongside* `agents.ts`, not as a replacement.** A single agent
(`agents.ts` registration) can spawn multiple concurrent Tasks (e.g., a fleet-batch build and
a test-suite run at once), and a Task's lifecycle is independent of whether the initiating
agent's heartbeat is still current. Do **not** try to unify the two id spaces — an agent ID and
a task ID answer different questions ("who is doing this" vs "how far along is this specific
operation").

`flow-metrics.ts` is a read path (aggregates over issue/sprint state), not a stateful entity —
no overlap; Tasks becomes a *new source* flow-metrics can eventually read from (see Runs, next).

### Contract

`tools/call` on a long-running tool returns:

```json
{
  "resultType": "task",
  "taskId": "<uuid>",
  "status": "working",
  "ttlMs": 300000,
  "pollIntervalMs": 2000
}
```

New methods: `tasks/get` (poll status + partial/final result), `tasks/update` (server- or
client-initiated status/progress patch — projektor only needs the server-initiated direction
for v1), `tasks/cancel`. Status enum: `working` / `input_required` / `completed` / `failed` /
`cancelled` — note `input_required` here is the MRTR pattern *nested inside* a task, for tools
that are both long-running *and* need a human checkpoint mid-flight (this is exactly the shape
Fleet Conductor, PROJ-468, would need).

### Storage

New D1 table `tasks` (workspace-scoped): `id`, `workspace_id`, `tool_name`, `status`,
`created_at`, `expires_at` (from `ttlMs`), `result_json` (nullable until terminal), `error_json`.
No new KV/R2 usage needed for v1 — task bodies are expected to be small (status + a result
payload, not artifact storage; artifacts a task produces still go through the existing
attachment/R2 path and get referenced by ID in the result).

### Pilot: Runs as first-class Task objects (PROJ-467)

A `run` (build, deploy, test suite, fleet batch) becomes a Task: the triggering tool
(`trigger_build`-shaped, if/when one exists — none does today, so this pilot is scoped to
**instrumenting an existing long-running MCP call once one exists**, not retrofitting a
currently-synchronous tool) returns `resultType: "task"`, linked to the issue/sprint it serves
via a `linked_issue_id` column on the new `tasks` table. This gives flow-metrics a real
wall-clock-work dimension without inventing a parallel tracking mechanism.

## PROJ-461: `subscriptions/listen` consolidation

**Blocked by PROJ-460 per the existing issue link** — the richest events to stream are task
status changes, so the Task storage/lifecycle from PROJ-460 needs to exist first.

### Contract

`subscriptions/listen` opens a long-lived stream. Client sends a `notifications` filter object;
server MUST first respond with `notifications/subscriptions/acknowledged` carrying
`io.modelcontextprotocol/subscriptionId` (echoing the listen request's JSON-RPC `id`) before
sending any other notification. The stream is **stateless across reconnects** — a dropped
connection means the client re-subscribes from scratch (no server-side replay buffer to build,
which fits projektor's existing no-session-state posture). Closes gracefully via an empty
`resultType: "complete"` response when the server decides to end the stream (e.g., workspace
deleted, token revoked).

### Transport reality check

projektor's MCP route is `POST /mcp/:workspaceId` on Cloudflare Workers — a single
request/response Worker invocation, not a persistent connection. `subscriptions/listen` needs a
push-capable transport that the current route doesn't have. **This is new infrastructure, not
just a new JSON-RPC method** — the design here is a filter-schema and ack-protocol only; the
transport choice needs its own implementation-planning pass, and is the main reason this
ticket stays `backlog` rather than being ready for an implementation task yet.

> **Correction (post-Opus-review):** the original draft proposed a per-workspace Durable
> Object "fanning out D1-write-triggered events" — but D1 has no change-notification
> mechanism; it emits nothing on write. Making that work would mean every mutating service
> across the codebase explicitly notifying the DO, which is a large, unscoped, cross-cutting
> change, not a contained addition. Two alternatives worth weighing at planning time instead:
> (a) a plain Worker endpoint doing SSE-via-polling — the client holds a connection open, the
> Worker polls a cursor over the existing `project_activity` table (already an append-log of
> the events this feature wants to stream) on a short interval and pushes new rows, no DO
> needed; or (b) plain HTTP long-poll (client re-requests with a cursor, server holds the
> request until new rows exist or a timeout). Both are simpler and cheaper than a
> DO-per-workspace, at the cost of higher latency than true push — likely an acceptable
> tradeoff given "stateless across reconnects" already means the design doesn't promise
> low-latency delivery. Whichever transport is chosen, two things are currently unaddressed and
> need resolving before implementation: (1) **per-token authorization filtering** — the stream
> must not leak events from issues/projects the subscribing token can't read; (2) **lossy
> delivery is unsafe for Tripwires (PROJ-470)** specifically, since it fires *automated*
> reactions — a dropped event with no replay buffer could silently skip a reaction with no
> record; PROJ-470's design should address whether that's acceptable or whether it needs an
> at-least-once guarantee this stream doesn't provide.

### What this unblocks

- **Live Ops Board (PROJ-469)** — direct consumer: issue transitions, claim grabs/releases,
  heartbeats, run/task progress as one filtered stream.
- **Tripwires (PROJ-470)** — declarative watch rules are a client-side filter over the same
  stream plus an optional MRTR confirmation hop before an automated reaction fires.
- **Fleet Conductor (PROJ-468)** — needs task-progress + heartbeat streaming to track a batch
  without polling; depends on both PROJ-460 (tasks) and this ticket.

Filter shape: `{ resourceSubscriptions: string[] (issue/sprint/task IDs), toolsListChanged:
boolean, promptsListChanged: boolean }` — `resourcesListChanged` from the spec doesn't map to
anything projektor has (no MCP `resources/` capability today), so it's a no-op filter key kept
only for spec-shape compatibility.

## PROJ-474: adopt the "modern" 2026-07-28 era

Given the cross-cutting decision above, this is **not required** to unblock MRTR/Tasks/
subscriptions. Re-scoping it as independent, lower-priority work with its own cost/benefit:

**Cost**: replace `initialize` with `server/discover` (which itself needs `ttlMs`/`cacheScope`
caching per its own spec section), parse `_meta.io.modelcontextprotocol/{protocolVersion,
clientInfo,clientCapabilities}` on every request instead of once at handshake, add the
`MCP-Protocol-Version` header, and support the new modern-era error codes. This touches every
request path in `mcp.ts`, not just `initialize` — bigger blast radius than any single ticket
in this epic so far.

**Benefit**: mainly forward-compatibility — staying on legacy works fine today (legacy-to-legacy
is a fully supported combination per spec), but the spec authors' stated trajectory is that
future capabilities may be modern-only. No concrete near-term feature in this epic's backlog
requires it.

**Recommendation**: leave PROJ-474 in backlog, unprioritized, until either (a) a future spec
capability projektor wants is modern-only, or (b) the MCP TypeScript SDK v2's legacy-mode
support is deprecated/removed, which would force the migration. Don't schedule it speculatively.

## Feature-idea backlog: exploration pass

Light-weight framing (not full designs) for the 9 `feature-idea` tickets, covering how each
maps onto the primitives above and rough sequencing:

| Ticket | Depends on | Notes |
|---|---|---|
| PROJ-464 Gated Transitions | PROJ-458 (MRTR) | Concrete pilot, detailed above. Ready for a design-doc-approved implementation task once PROJ-458 is signed off. |
| PROJ-466 Contested-Claim Arbitration | PROJ-458 (MRTR) | Same `input_required` contract as Gated Transitions, applied to `claim_files`/`claim_issue` collision instead of a status transition. Second MRTR pilot, not first — let Gated Transitions prove the `requestState` signing pattern first. |
| PROJ-467 Runs as first-class Task objects | PROJ-460 (Tasks) | Concrete pilot, detailed above. Currently has no synchronous tool to convert (no `trigger_build` exists) — real value lands once a long-running tool exists to instrument. |
| PROJ-468 Fleet Conductor (speculative) | PROJ-460 + PROJ-461 | Correctly the most ambitious — needs Tasks *and* subscriptions *and* MRTR (for plan-level human escalation) all landed first. Keep speculative/last. |
| PROJ-469 Live Ops Board | PROJ-461 (subscriptions) | Direct consumer, detailed above. Natural first subscriptions/listen client once the Durable Object transport exists. |
| PROJ-470 Tripwires | PROJ-461 (subscriptions) + PROJ-458 (MRTR, optional confirmation hop) | Second subscriptions/listen client after Live Ops Board proves the transport. |
| PROJ-471 Definition-of-Ready Intake Interview | PROJ-458 (MRTR) | `create_issue` on an under-specified ticket returns `input_required` with DoR gaps as structured questions. Third MRTR use case — same contract as Gated Transitions, different trigger point (`create_issue` instead of `update_issue`). Confirms PROJ-458's contract generalizes beyond one call site before building Fleet Conductor on top of it. |
| PROJ-472 Edge-Cellular Workspaces (speculative) | none of the above directly | Orthogonal — about Worker/D1 topology (per-workspace shard routing), not a protocol feature. Genuinely speculative infra work; no dependency on this epic's other tickets. Leave speculative/unscheduled. |
| PROJ-473 Attention Ledger | PROJ-458 (MRTR) | Metering layer on top of MRTR resume events (every human touchpoint is now a timestamped resume) — cheap to add once Gated Transitions exists, since it's mostly "log the resume event," not new protocol surface. |

**Suggested sequencing if this epic continues past design**: PROJ-458 (MRTR design/impl) →
PROJ-464 (Gated Transitions pilot) → PROJ-471 (second MRTR call site, validates generality) →
PROJ-460 (Tasks design/impl) → PROJ-467 (Runs pilot, once a long-running tool exists) →
PROJ-461 (subscriptions transport) → PROJ-469 (Live Ops Board) → PROJ-466/470/473 (second-wave
consumers) → PROJ-468 (Fleet Conductor, last). PROJ-472 and PROJ-474 are independent side
tracks, schedule opportunistically.

## Verification

Per each design ticket's acceptance criteria: this doc is the artifact for human review. No
code changes are proposed here. Readiness differs per ticket, corrected from an earlier,
overly-uniform claim that all three get "exactly one implementation task":

- **PROJ-458 (MRTR)** is the closest to implementation-ready, once the `requestState`/verdict
  design above and the `MCPTool` handler-signature change are accepted.
- **PROJ-460 (Tasks)** is implementation-ready as a contract, but its pilot (PROJ-467) has no
  target tool yet — the implementation task should land the `tasks` infrastructure without
  requiring a simultaneous pilot conversion.
- **PROJ-461 (subscriptions)** is **not** ready for a single implementation task — it needs its
  own transport-design pass first (per the correction above) before an implementation task can
  be scoped at all.
