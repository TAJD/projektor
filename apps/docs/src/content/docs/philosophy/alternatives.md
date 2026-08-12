---
title: "Projektor and the agent-coordination field"
description: "A point-in-time comparison of Projektor against other tools agents use to coordinate work — what each is genuinely good at, and where the differences are deliberate design choices rather than gaps."
sidebar:
  order: 4
---
*Snapshot as of 2026-08-12.* This page compares Projektor against other tools
in the agent-coordination space, based on a survey of their public
documentation, READMEs, and product pages on that date. Nothing was
installed or run, and no source was read for closed-source products —
absence from documentation is weaker evidence than absence from a schema, and
that limitation is intentionally not smoothed over below. Tools evolve
quickly in this space; treat every claim here as dated the moment you read
it, not as a permanent ranking.

The goal isn't to declare a winner. Several of these tools are better than
Projektor at the thing they're built for. The point of writing this down is
to be specific about which thing that is, so the comparison holds up rather
than reading as marketing.

## The axes Projektor is making a bet on

1. **Leases on work items, not just files.** Projektor claims at two levels:
   path-level file claims (`apps/api/src/services/file-claims.ts`) and
   issue-level leases (`apps/api/src/services/issue-leases.ts`). The lease
   layer enforces a per-project `agent_wip_limit` — an admission-control cap
   on how many issues a project can have actively leased at once, defaulting
   to 3, denials of which are themselves recorded (`wip_cap_denials`). This
   is backlog-level flow control, not just "don't edit the same file twice."
2. **Contention as a derived asset.** Every rejected or force-overridden file
   claim is written to a `claim_conflicts` table (path, rejecting issue/agent,
   holding issue/agent, whether it was forced, when) and aggregated over a
   time window into a contention ranking exposed to a health view. Refused
   claims are data here, not just errors.
3. **Deployed, self-hostable, and unified.** Local-first tools structurally
   can't coordinate a fleet across machines and CI; hosted tools can't be
   self-hosted. Projektor tries to sit in the quadrant that does both, which
   as far as this survey found is uncontested — nobody else in the list below
   occupies it.
4. **Validated by use.** Projektor's own backlog is tracked in Projektor, and
   this comparison page is itself a PROJ ticket worked by an agent claiming
   it through the mechanism described above.

Claims 1 and 3 above are checked directly against
`apps/api/src/services/issue-leases.ts`, `apps/api/src/services/file-claims.ts`,
and `packages/db/migrations/0032_claim_conflicts.sql` as of this snapshot,
not just asserted from documentation.

## Contention telemetry: what "tracks conflicts" actually means

This phrase gets used loosely enough that it's worth separating three
distinct things:

1. **Live conflict detection** — a claim attempt is refused and the caller
   is told why, in the moment.
2. **Reservation lifecycle history** — a queryable record of past
   reservations, including released or expired ones.
3. **Conflict events as their own persisted records**, aggregated over a
   window into a ranking of which paths are hot.

Most tools that "track conflicts" do (1). Projektor's contention claim is
specifically (3): a refused claim never becomes a reservation, so under a
model that only stores reservations, a refusal leaves no row at all unless
someone deliberately records the refusal as its own event. Projektor does
that. Of the tools surveyed in August 2026, none exposed an equivalent
aggregation — the closest, MCP Agent Mail's Rust TUI, surfaces conflicts live
and has an analytics screen aimed at system anomalies rather than path
contention.

## The tools, alternative by alternative

### MCP Agent Mail (Python) — `Dicklesworthstone/mcp_agent_mail`

Its real strength is negotiation *after* detection, which Projektor doesn't
have at all: agents hold advisory file reservations with TTL expiry and
stale reclaim, can message each other in a threaded conversation about a
conflict, and a pre-commit guard blocks a commit that conflicts with another
agent's exclusive reservation. That's a materially richer conflict-resolution
loop than "the claim is rejected, go pick something else."

Its data model is `file_reservations(id, project_id, agent_id, path_pattern,
exclusive, reason, created_ts, expires_ts, released_ts)` — no separate
conflict-event table. Its web UI's File Reservations list, showing active and
historical reservations, is category (2) above: reservation history, not
aggregated conflict events. That's a genuinely useful view; it answers "what
was reserved and when," just not "which paths are contended most."

### MCP Agent Mail (Rust) — `mcp_agent_mail_rust`

The Rust rewrite is the most feature-dense tool in this list: roughly 34
tools and a 16-screen TUI, including a Reservations screen described as
covering "file reservation status, conflicts, and create/release actions,"
plus Tool Metrics, Analytics, Timeline, ATC, and System Health screens, and a
dedicated `check_file_reservation_conflicts` tool. Its live conflict
visibility is richer than Projektor's — this is worth stating plainly rather
than downplaying. It also has an analytics surface, documented as an
anomaly-insight feed with confidence scores and deep links: system anomalies,
not path-contention ranking. That's a real gap in what Projektor's
contention view covers versus what this tool's analytics covers, just not
the same gap — they're aimed at different questions.

### Hiveship

An agent-first issue tracker strong on run observability: live SSE run
streams, per-run activity logs, a review queue, PR links, and signed
webhooks for the human review flow. That's a well-built operational surface
for watching what an agent is doing in real time, which Projektor doesn't
attempt to match.

Its public pages document no file-level or path-level coordination at all.
That reads as a different scope rather than a missing feature — Hiveship
appears to be optimized for run visibility and review, not for multiple
agents contending over the same paths, so there's no contention signal for
it to aggregate in the first place.

### beads / Gas Town

`bd update <id> --claim` is a clean, atomic issue-level claim (sets assignee
and moves to in_progress), and beads' dependency-aware ready queue is
genuinely good — it's a sharper "what should I work on next" primitive than
Projektor's own prioritization in several respects and worth crediting
plainly rather than hedging. Gas Town layers tmux sessions, background
daemons, and worktree-based agent identities on top.

Neither documents file-level or path-level locks, or a stats/metrics
command. If two agents claim different issues that happen to touch the same
file, beads' issue-level claim model has no mechanism to see that coming.

### Linear + MCP

Linear shipped native MCP agent support in April 2026, with issue-level
assignment to agents. Product polish and ecosystem breadth here are hard to
match — this is a mature, widely-integrated product, not a coordination
experiment. It's hosted only; there's no self-hosted deployment path, which
is a deliberate product decision on Linear's part, not an oversight.

### Atlassian MCP

Issue-level agent access to Jira and Confluence, backed by Atlassian's
enterprise reach and integration breadth. For an organization already
standardized on Jira, the switching cost of adopting anything else is real
and Atlassian MCP avoids it entirely. It doesn't appear to add file- or
path-level coordination beyond issue assignment.

### Worktree tooling — agentree, gwq, Clash, ccswarm

These solve isolation and parallel-run mechanics — giving each agent its own
worktree, managing branch lifecycle, running agents concurrently — well.
They're complementary to an issue tracker, not competing with one: nothing
stops someone running Projektor for coordination and one of these for the
worktree mechanics underneath. Worth naming as a "both," not an "either/or."

### Lightweight git-native trackers

Plain-text issues committed alongside the code they describe. The strengths
are real and easy to undervalue: zero infrastructure, and every change to an
issue is reviewable in a normal diff and PR. For a single repo with a small
number of contributors, that's plausibly all the coordination anyone needs.
It's a local-first, single-repo bet — the same structural tradeoff described
in the "deployed and self-hostable" section above, just from the other side:
no server to run, and no coordination across repos or machines either.

## Reading this table

The table below is a compressed index, not the argument — read the prose
above for the parts that don't survive compression (Agent Mail Rust's
analytics screen, in particular, is easy to misread from a checkmark alone).

| Tool | Issue-level claim | File/path-level claim | Live conflict detection | Aggregated contention over time | Deployment |
|---|---|---|---|---|---|
| Projektor | yes (leases + WIP cap) | yes | yes (rejection) | yes | self-hosted, deployed |
| MCP Agent Mail (Python) | no | yes (reservations) | yes | no (reservation history only) | self-hosted |
| MCP Agent Mail (Rust) | no | yes (reservations) | yes | no (system-anomaly analytics, not path contention) | self-hosted |
| Hiveship | yes | not documented | not documented | not documented | hosted |
| beads / Gas Town | yes (`--claim`) | no | no | no | local-first |
| Linear + MCP | yes | no | no | no | hosted only |
| Atlassian MCP | yes | no | no | no | hosted only |
| Worktree tooling | n/a (not a tracker) | isolation, not claims | n/a | n/a | local |
| Lightweight git trackers | manual | no | no | no | local-first |

## What would change this page

This is a snapshot, and the field is moving quickly — several of the tools
above are pre-1.0 or shipped major features within the last few months of
this writing. If a tool listed here adds path-level contention aggregation,
or if closed-source documentation surfaces evidence this survey didn't have
access to, this page should be corrected rather than left to go stale
silently.
