---
title: "Epic-driven autonomous goals"
description: "Compose a standing goal directive for autonomously working an epic (or ticket list) to completion."
sidebar:
  order: 1
---
A prompt pattern for pointing an agent at an epic (or ticket list) and having it work
autonomously until everything — including work it discovers along the way — is done.

## The six ingredients

The productive runs all combined these; the weak ones ("implement 134") had only the first:

1. **Concrete entry point** — an epic ref/URL or explicit ticket IDs.
2. **Explicit autonomy grant** — "autonomously", "do not stop until…". Sessions with this
   stall far less.
3. **Review cadence with a named model** — "use opus for reviews every two tickets". The
   cadence survives context compaction and gets self-enforced.
4. **Self-feeding loop** — file tickets for discovered bugs/improvements, link them to the
   epic, action them. Turns the epic into a generator, not a fixed list.
5. **Verifiable termination condition** — "complete when the epic is implemented AND shown
   to work on all test repos", not "when done".
6. **Decisions log instead of interruptions** — record decisions and judgment calls as
   comments on the epic for review at the end, rather than asking questions mid-run.

Plus one situational clause that earned its place: **audit-first** — on resumed work,
audit origin/main, open PRs, and local state before implementing anything, so finished
work is folded in rather than redone.

Call `compose_playbook("epic-goal", { epicRef, variant, reviewModel, cadence })` to have
the server fill the template below with live data (epic title, open child count, project
WIP limit) instead of copying it out by hand.

## Template — bounded variant (default)

> **Goal:** work through {EPIC} autonomously until it is fully done.
>
> **Audit first:** before implementing anything, audit origin/main, open PRs, and local worktree state so already-finished or in-flight work is folded in, not redone.
>
> **Loop:** pick the next open ticket on the epic (`get_prioritized_issues`), implement it, verify (tests/build), commit, close the ticket, move on.
>
> **Self-feed (bounded):** file tickets for bugs, improvements, and follow-on features you discover and link them to the epic — but only action ones that block or directly improve the epic's outcome. Park everything else in the backlog untriaged. At each review checkpoint, have the reviewer rank the parked tickets and drop any not worth keeping.
>
> **Review cadence:** after every {N} completed tickets, run an adversarial {MODEL} review of the accumulated diff; file and fix anything it finds before continuing.
>
> **Done when:** every ticket on the epic (original + actioned generated) is closed, verification is green, and everything is committed and pushed.
>
> **Decisions log:** instead of asking questions, make the call and record decisions, tradeoffs, and anything needing human judgment as comments on the epic for review at the end. If two reasonable implementations diverge, comment both options on the ticket, pick the simpler, and flag it.

## Template — full variant

Same as bounded, with the self-feed clause replaced by:

> **Self-feed (full):** file tickets for bugs, improvements, and follow-on features you discover, link them to the epic, and action them in the same loop — the goal covers generated work, not just the original tickets.

And "done when" covers original + generated tickets.

## Choosing a variant

| Situation | Variant |
|---|---|
| Epic has a crisp outcome; scope creep is the risk | bounded |
| Exploratory/quality epic where discovered work IS the point | full |

Full-variant runs can generate more tickets than the epic started with; if that happens
mid-run, switch to bounded and park the tail.

## Fleet / multi-agent use

For epics too large for one session, the same template works as a worker prompt: post it
as a comment on the epic and pass the ticket URL as the worker's entry point, with each
worker taking disjoint tickets.
