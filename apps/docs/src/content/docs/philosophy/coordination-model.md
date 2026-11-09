---
title: "Coordination model"
description: "How Projektor coordinates concurrent agents: identity, leases, file claims, and conflict routing, as a designed distributed system."
sidebar:
  order: 3
---
Several agents can work the same workspace at once, so Projektor has to answer what any
concurrent system does: how participants prove they're alive, how contended work is handed
out, what happens when one disappears mid-task, and how contention is surfaced instead of
failing silently. This page treats the answer as a small distributed system. The workflow
rules themselves live in the [workflow spec](/projektor/agents/workflow-spec/) (`get_workflow`);
where the code lives is listed [at the end](#where-it-lives).

## Identity and liveness

An agent's presence in the system is an `agent_sessions` row, created by
`register_agent` (or `start_work`) and kept alive by heartbeats; any session-scoped call
counts as one. There is no separate presence service: liveness is a plain column
comparison. A session is live when its `status` is `"active"` and its `last_heartbeat_at`
is newer than one session TTL (`SESSION_TTL_SECONDS`, a couple of minutes; see
[Where it lives](#where-it-lives)).

A session also records the credential that created it, so an agent alone on its
credential can omit its session id; a fleet sharing one token must still pass it.

That one number is the liveness window for the whole coordination layer: it decides
when `list_active_agents` stops listing a session, when a lease on that session's issue
becomes reclaimable, and when a claiming agent is rejected as not-live. There's no separate expiry sweep — liveness is computed at
read time from `lastHeartbeatAt`, so nothing can drift out of sync with a background
job that didn't run.

## Two tiers of claiming

Projektor separates "who owns this unit of work" from "who owns this file", and
enforces both independently.

**Issue leases** (table `issue_leases`) are
work-item-level: `claim_issue` grants one agent session exclusive ownership of one
issue, enforced by a partial `UNIQUE` index on `(workspace_id, issue_id) WHERE
released_at IS NULL`. This is what prevents two agents from independently picking up
and duplicating the same ticket.

**File claims** (table `issue_file_claims`) are
path-level: `claim_files` reserves a set of paths against an issue. This is what prevents
two agents working *different* issues from editing the same files and producing a merge
conflict neither of them can resolve on their own.

Conflict detection here is **exact string matching**, not glob or prefix matching:
`claim_files` takes an array of path strings (up to 100 per call) and the conflict query is an `inArray` over literal path values. Claiming
`src/` does not reserve `src/foo.ts`, and claiming `src/*.ts` reserves a path whose
literal name is `src/*.ts`. Two agents can therefore collide on the same file if they
name it differently, and coordination depends on the fleet using consistent, concrete
paths.

Neither tier can do the other's job. An issue lease says nothing about which files an
issue touches — an agent could hold a lease and still stomp on a file another lease
holder is also relying on. A file claim says nothing about which agent is responsible
for finishing the issue — without the lease, two agents could each claim disjoint file
sets for the same issue and both believe they own it. Because the tiers are independent,
an agent can claim files under an issue it doesn't hold the lease on (a reviewer editing
a small file while the implementer holds the lease, for instance) — the schemas allow
`issueId` on a file claim without requiring a live lease on that issue.

## WIP limit as admission control

`agent_wip_limit` caps how many issues in a project can be under a live lease at once.
The default and how to override it are in the
[workflow spec](/projektor/agents/workflow-spec/#wip-limits).
It is not a rate limit on claim attempts; it's an admission-control gate on how much of
the backlog can be in flight simultaneously. The lease claim enforces it as part of the same
`INSERT ... SELECT ... WHERE (live-lease count) < cap` statement that grants the lease,
so the check and the grant happen atomically — D1 has no interactive transactions, and a
separate read-then-insert would let two concurrent claims each see `cap - 1` and both
proceed. Hitting the cap raises a `ConflictError` and writes a row to `wip_cap_denials` — event data for factory-health
tooling, not just an error message that disappears once returned.

## Stale reclaim, not deadlock

A lease's liveness is derived from its holder's session, not stored independently:
the lease claim looks at the existing lease's owning
session and only treats it as a genuine conflict if that session is still active and
within the heartbeat TTL. If the holder stopped heartbeating — crashed, was killed,
lost its process — the lease is released with `release_reason: "expired"` and the new
claim proceeds in the same call. There is no separate expiry job, no manual "force
release" step, and no permanently stuck issue: a crashed agent can never leave a lease
that outlives it by more than the TTL.

**File claims work the same way** (PROJ-636). The
next `claim_files` on a contested path checks the holding claim's session the way the lease
tier checks the holding lease's: if that session stopped heartbeating, the claim is released
with `release_reason: "expired"` and the new claim proceeds. A crashed agent frees both its
ticket and its files.

File claims originally had no expiry, so an agent that died without ending its session held
its paths forever. For spawned workers a crash is the normal exit, so that gap mattered.

Two consequences of closing it that are easy to miss:

- **`agent_ended` and `expired` mean different things, deliberately.** A clean `end_agent`
  still releases eagerly and still records `agent_ended`; only an abandoned claim records
  `expired`. Collapsing them would make a crash indistinguishable from a tidy exit in the
  factory-health data, which is precisely the signal you want when a fleet is misbehaving.
- **Reclaiming a dead holder is not recorded as contention.** No `claim_conflicts` row is
  written when a claim supersedes a stale one. The contention log exists to say something
  about how the work was sliced (see below); fleet mortality is not a collision between two
  live agents, and counting it as one would inflate the heatmap with deaths rather than
  disagreements.

One case sits outside liveness: a claim with no `agent_id` — made without a session, or
orphaned because the `agent_id` foreign key is `ON DELETE SET NULL`. There is no heartbeat to
judge those by, so they fall back on claim age: after `FILE_CLAIM_TTL_SECONDS` (default 24
hours, PROJ-928) the next claimer reclaims them; before that, `force` is the only way past.
The TTL is long on purpose, a backstop for the minority of claims without a session rather
than a second liveness clock.

## Conflict routing

Routing is *informational, not conversational*: a collision tells the claiming agent who
it hit and records the collision, but agents don't negotiate. It resolves one of two ways.

**Rejection.** When `claim_files` finds an existing active claim on a requested path and
the caller did not pass `force`, the server rejects the whole
request — all-or-nothing, so no partial claim survives — and throws a `ConflictError`
naming the holding issue and agent. The blocked agent therefore learns exactly who to
talk to, and can do so with `post_message`. Nothing is pushed to the holder: it is still
working and nothing about its claim changed.

**Forced override.** When the caller passes `force`, the existing claim is released as
`overridden` and two messages are posted (PROJ-635): one to `issue:<claiming issue>` —
an audit record naming the displaced issue — and one to `issue:<displaced issue>`, so the
agent that lost the path is told directly rather than discovering it when its own next
write or claim fails.

Both paths persist the collision as a `claim_conflicts` row. Rejection pushes nothing to the holder — its claim didn't change, so there's nothing
for it to react to — but a forced override does, since a live agent's assumption about what
it owns just became false (PROJ-635's reasoning for treating the two cases differently). A
tool built specifically around negotiation — MCP Agent Mail, whose agents message each
other and pick different files — is genuinely better at the rejection step, and
[how Projektor differs](/projektor/philosophy/alternatives/) says so. What Projektor does
instead of negotiating there is *record*, which is the subject of the next section.

## Conflict as an event log

Every contended path, whether the claim was rejected or forced through, is written to
`claim_conflicts`: the path, the
issue and agent that lost the attempt, the issue and agent that held it, a `forced` flag
(`0` for a hard rejection, `1` for an override), and `occurred_at`. It's an append-only
event log, not a derived view — a rejected claim leaves no row anywhere else (the
rejection happens entirely in-process, before any insert into `issue_file_claims`), so
this table is the only record that the contention happened at all.

The table carries two indexes: `(workspace_id, occurred_at)` and `(workspace_id, path)`.
Both exist because `get_code_heatmap` runs in two modes over the same data shape.
Claims mode groups `issue_file_claims` rows by path prefix within a time window, sized
by how much work happened in a directory. Contention mode groups `claim_conflicts` the
same way, sized by how much *contention* happened there — which paths agents keep
colliding on, not just which paths get touched. Windowed contention ranking (`since`,
`until`, drilling into a path prefix) is what the `(workspace_id, occurred_at)` and
`(workspace_id, path)` indexes make cheap; without them, "which files caused the most
conflicts this week" would mean scanning the whole event log per query.

## Why coordination lives in the tracker, not beside it

The alternative to this design is a tracker plus a separate coordination sidecar — a
lock service, a presence system, a message queue bolted on next to the issue database.
That split creates two sources of truth that can disagree: the tracker says an issue is
in progress, the sidecar says the lease expired, and nothing reconciles them except
whoever notices first.

Projektor keeps the lease on the issue and the claim on the file in the same schema as
the issue itself, behind the same workspace/auth boundary as everything else (`ctx.workspaceId`
scoping on every query above). An issue's lease history, an agent's heartbeat, and a
file's claim conflicts are all queryable alongside the issue's comments and status
transitions, because they're rows in the same database, not calls to a different system
that happens to reference the same issue IDs. Coordination state is derived from the
work graph — who's allowed to touch what, right now — rather than kept next to it and
hoping the two stay in sync.

## Where it lives

| Concern | Code |
|---|---|
| Sessions and heartbeats | `apps/api/src/services/agents.ts`, `agent-identity.ts` (`SESSION_TTL_SECONDS`) |
| Issue leases and the WIP cap | `apps/api/src/services/issue-leases.ts` (`DEFAULT_AGENT_WIP_LIMIT`) |
| File claims, stale reclaim, conflict rows | `apps/api/src/services/file-claims.ts` (`FILE_CLAIM_TTL_SECONDS`), `schemas/file-claims.ts` |
| Override notices | `apps/api/src/services/agent-messages.ts` |
| Contention heatmap | `apps/api/src/services/code-heatmap.ts` |
| Tables | `packages/db/migrations/0032_claim_conflicts.sql`, `0039_wip_cap_denials.sql` |
