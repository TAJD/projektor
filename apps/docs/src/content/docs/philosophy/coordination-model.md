---
title: "Coordination model"
description: "How Projektor coordinates concurrent agents: identity, leases, file claims, and conflict routing, as a designed distributed system."
sidebar:
  order: 3
---
Projektor is designed to have several agents working the same workspace at once. That
means it has to answer the questions any concurrent system has to answer: how do
participants prove they're alive, how is contended work handed out without two workers
grabbing the same thing, what happens when a participant disappears mid-task, and how
does contention get surfaced instead of silently failing. This page describes the
mechanism Projektor uses to answer them — not as a feature list, but as a small
distributed system with its own liveness, admission-control, and conflict-resolution
properties.

This page does not restate the workflow rules (definition of ready, the state machine,
human review gates) — those live in exactly one place, the
[workflow spec](/projektor/agents/workflow-spec/), fetched programmatically via
`get_workflow`.

## Identity and liveness

An agent's presence in the system is an `agent_sessions` row, created by
`register_agent` and kept alive by periodic `heartbeat_agent` calls
(`apps/api/src/services/agents.ts`). There is no separate presence/heartbeat service:
liveness is a plain column comparison. A session counts as live when its `status` is
`"active"` and its `last_heartbeat_at` is newer than `ACTIVE_TTL` seconds ago — currently
**120 seconds**, defined as `ACTIVE_TTL` in `apps/api/src/services/agents.ts`. The same
constant is duplicated (deliberately, to avoid a circular import between the two
services) as `SESSION_TTL_SECONDS` in `apps/api/src/services/issue-leases.ts`, with a
comment pointing back at the original.

That one number is the liveness window for the whole coordination layer: it decides
when `list_active_agents` stops listing a session, when a lease on that session's issue
becomes reclaimable, and when a claiming agent is rejected as not-live in
`assertAgentSessionLive`. There's no separate expiry sweep — liveness is computed at
read time from `lastHeartbeatAt`, so nothing can drift out of sync with a background
job that didn't run.

## Two tiers of claiming

Projektor separates "who owns this unit of work" from "who owns this file", and
enforces both independently.

**Issue leases** (`apps/api/src/services/issue-leases.ts`, table `issue_leases`) are
work-item-level: `claim_issue` grants one agent session exclusive ownership of one
issue, enforced by a partial `UNIQUE` index on `(workspace_id, issue_id) WHERE
released_at IS NULL`. This is what prevents two agents from independently picking up
and duplicating the same ticket.

**File claims** (`apps/api/src/services/file-claims.ts`, table `issue_file_claims`) are
path-level: `claim_files` reserves a set of paths against an issue. This is what prevents
two agents working *different* issues from editing the same files and producing a merge
conflict neither of them can resolve on their own.

Conflict detection here is **exact string matching**, not glob or prefix matching:
`claim_files` takes an array of path strings (`apps/api/src/schemas/file-claims.ts`, up to
100 per call) and the conflict query is an `inArray` over literal path values. Claiming
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

`agent_wip_limit` (read via `fetchAgentWipCap` in `apps/api/src/services/issue-leases.ts`)
caps how many issues in a project can be under a live lease at once — currently
`DEFAULT_AGENT_WIP_LIMIT = 3`, overridable per project via `projects.agent_wip_limit`.
It is not a rate limit on claim attempts; it's an admission-control gate on how much of
the backlog can be in flight simultaneously. `claimIssue` enforces it as part of the same
`INSERT ... SELECT ... WHERE (live-lease count) < cap` statement that grants the lease,
so the check and the grant happen atomically — D1 has no interactive transactions, and a
separate read-then-insert would let two concurrent claims each see `cap - 1` and both
proceed. Hitting the cap raises a `ConflictError` and writes a row to `wip_cap_denials`
(`packages/db/migrations/0039_wip_cap_denials.sql`) — event data for factory-health
tooling, not just an error message that disappears once returned.

## Stale reclaim, not deadlock

A lease's liveness is derived from its holder's session, not stored independently:
`reclaimStaleLeaseOrThrow` in `issue-leases.ts` looks at the existing lease's owning
session and only treats it as a genuine conflict if that session is still active and
within the heartbeat TTL. If the holder stopped heartbeating — crashed, was killed,
lost its process — the lease is released with `release_reason: "expired"` and the new
claim proceeds in the same call. There is no separate expiry job, no manual "force
release" step, and no permanently stuck issue: a crashed agent can never leave a lease
that outlives it by more than the TTL.

**The two tiers are not symmetric here, and this is the layer's weakest point.** Issue
leases are reclaimed from liveness, as above. File claims are not: there is no TTL-based
expiry for them at all. A claim is released when the agent calls `release_files`, or when
its session formally ends and `releaseClaimsForAgent` marks the rows
`release_reason: "agent_ended"` (`file-claims.ts`, PROJ-334). An agent that dies without
ending its session — the crash case the lease tier handles cleanly — leaves its file
claims held indefinitely, and the only way out is a `force` claim by someone else. The
comment on `releaseClaimsForAgent` says as much: agent-end is the only abandonment path
today.

So a crashed agent frees its ticket automatically but not its files. Worth knowing before
relying on claims as the only guard in a long-running fleet.

## Conflict routing

A collision resolves in one of two ways, and it is worth being exact about who learns
what, because the answer is narrower than "agents negotiate".

**Rejection.** When `claim_files` finds an existing active claim on a requested path and
the caller did not pass `force`, `assertNoConflicts` in `file-claims.ts` rejects the whole
request — all-or-nothing, so no partial claim survives — and throws a `ConflictError`
naming the holding issue and agent. The blocked agent therefore learns exactly who to
talk to, and can do so with `post_message`. Nothing is pushed to the holder: it is still
working and nothing about its claim changed.

**Forced override.** When the caller passes `force`, the existing claim is released as
`overridden` and `overrideConflictingClaims` posts a message via `postMessage`
(`apps/api/src/services/agent-messages.ts`). Note the scope: the message goes to
`issue:<claiming issue>` — the issue that just took the path — naming the displaced issue
in the body. It is an audit record on the overrider, not a notification to the overridden.

So the routing is *informational, not conversational*. Both paths tell the agent doing the
claiming who it collided with, and both persist the collision as a `claim_conflicts` row.
Neither pushes anything to the agent that lost the path; that agent finds out when its
next write or claim fails. A tool built specifically around negotiation — MCP Agent Mail,
whose agents message each other and pick different files — is genuinely better at this
particular step, and [how Projektor differs](/projektor/philosophy/alternatives/) says so.
What Projektor does instead of negotiating is *record*, which is the subject of the next
section.

## Conflict as an event log

Every contended path, whether the claim was rejected or forced through, is written to
`claim_conflicts` (`packages/db/migrations/0032_claim_conflicts.sql`): the path, the
issue and agent that lost the attempt, the issue and agent that held it, a `forced` flag
(`0` for a hard rejection, `1` for an override), and `occurred_at`. It's an append-only
event log, not a derived view — a rejected claim leaves no row anywhere else (the
rejection happens entirely in-process, before any insert into `issue_file_claims`), so
this table is the only record that the contention happened at all.

The table carries two indexes: `(workspace_id, occurred_at)` and `(workspace_id, path)`.
Both exist because `get_code_heatmap`
(`apps/api/src/services/code-heatmap.ts`) runs in two modes over the same data shape.
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
