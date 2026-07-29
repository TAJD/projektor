# MRTR, Tasks extension, subscriptions/listen: design for PROJ-458 / PROJ-460 / PROJ-461 / PROJ-474

Covers the four "Design:"/adoption tickets under the PROJ-451 epic. Builds on
[the phase-1-3 compliance work](./2026-07-29-mcp-2026-07-28-update-plan.md) (PROJ-452/454/456,
shipped in v0.4.16) and on primary-source spec pages fetched directly from
`modelcontextprotocol.io` (not the announcement blog post) for MRTR, the Tasks extension,
`subscriptions/listen`, and `server/discover`.

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

Only `tools/call`, `prompts/get`, and `resources/read` may return this shape per spec — matches
projektor's surface exactly, since those are the only three methods this server implements
handlers for beyond `tools/list`/`initialize`.

### `requestState` integrity

The spec flags `requestState` as requiring integrity protection when it affects authorization
— it does here: a forged `requestState` could let a caller skip the review gate and claim
"approved" on a transition they never saw. **Sign it**: HMAC-SHA256 over
`{ toolName, arguments, workspaceId, issueId, targetStatus, expiresAt }` using a
worker-secret key (new `MRTR_STATE_SECRET` binding, same pattern as existing token hashing in
`auth.ts`). Verify + expiry-check on resume; reject with `-32602` if the signature or
expiry fails. This keeps the gate stateless — no server-side session/lease needed to track an
in-flight MRTR exchange, consistent with projektor's existing statelessness.

### Pilot: Gated Transitions (PROJ-464)

`update_issue` calls that cross a workflow human-review gate (defined by `get_workflow`'s
existing state-machine config) return `input_required` instead of the current out-of-band
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

### Open question flagged for implementation time

The exact discriminated-union field names (`resultType`, `inputRequests` vs `requests`, etc.)
should be verified against the TypeScript SDK's actual type definitions
(`@modelcontextprotocol/typescript-sdk`, v2) before coding — this doc's field names are drawn
from the spec's prose/schema description fetched via WebFetch, not from reading the SDK source
directly, and the earlier protocolVersion/cacheScope mistakes in this same epic are a reminder
to verify against the primary type definitions, not just spec prose, before implementation.

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
push-capable transport (SSE or a Durable Object-backed WebSocket) that the current route
doesn't have. **This is new infrastructure, not just a new JSON-RPC method** — the design here
is a filter-schema and ack-protocol; the transport choice (Durable Object per workspace,
holding open SSE connections and fanning out D1-write-triggered events) needs its own
implementation-planning pass and is the main reason this ticket stays `backlog` rather than
being ready for an implementation task yet.

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
code changes are proposed here. Once approved, PROJ-458/460/461 each get exactly one
implementation task created from their respective sections above (not before).
