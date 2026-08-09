---
title: "Epic-driven autonomous goals"
description: "Compose a standing goal directive for autonomously working an epic (or ticket list) to completion."
sidebar:
  order: 1
---
A prompt pattern for pointing an agent at an epic (or ticket list) and having it work
autonomously until everything — including work it discovers along the way — is done.

It's deliberately generic. [The workflow spec](/projektor/agents/workflow-spec/) is the
projektor-specific half — definition of ready, the status state machine, human review
gates, fleet coordination rules. This playbook is the shape of the *run* that drives
those rules, so an agent working an epic normally fetches both.

## Getting the directive

`get_playbook("epic-goal")` returns this page verbatim, template and all — read it and
adapt it by hand.

`compose_playbook("epic-goal", { epicRef, variant, reviewModel, cadence })` returns just
the directive, with every placeholder already filled from data the server holds:

| Parameter / source | Fills |
|---|---|
| `epicRef` *(required)* — resolved to the epic's ref and title | the **Goal** clause |
| `variant` — `bounded` (default) or `full` | the **Self-feed** and **Done when** clauses |
| `cadence` (default 2) and `reviewModel` (default `opus`) | the **Review cadence** clause |
| the epic's open child count and the project's agent WIP limit | an extra **Live data** clause |

MCP clients that support the `prompts` primitive surface the same composed directive as a
slash command, with the three optional parameters as prompt arguments.

## What each clause is for

- **Goal** — a concrete entry point (an epic ref, not a prose description) plus an explicit
  autonomy grant. Without the grant a run tends to stop after the first ticket to ask
  what's next.
- **Audit first** — on a resumed run, an agent that doesn't look first repeats work that
  is already merged to origin/main or sitting in an open PR. This is also the clause that
  matters most after a context compaction, when the agent's memory of the run is gone but
  the directive isn't.
- **Loop** — `get_prioritized_issues` chooses the next ticket rather than the agent, so
  ordering follows the project's own priority and blocked-by rules.
- **Self-feed** — filing discovered bugs and follow-ons back onto the epic turns it into a
  generator rather than a fixed list. This is the only clause the two variants differ on.
- **Review cadence** — naming the model and the interval up front makes the checkpoint
  something the agent can self-enforce; "review as you go" doesn't survive a long run.
- **Done when** — a checkable condition (every ticket closed, verification green,
  everything pushed) instead of a judgment call.
- **Decisions log** — judgment calls land as comments on the epic for review at the end,
  so an ambiguity doesn't block the run on a question.

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
| Exploratory/quality epic where the discovered work *is* the point | full |

Full-variant runs can generate more tickets than the epic started with; if that happens
mid-run, switch to bounded and park the tail.

## Fleet and multi-agent use

For epics too large for one session, the same directive works as a worker prompt: post it
as a comment on the epic and give each worker the ticket URL as its entry point. Nobody
hands out the tickets: each worker takes its own through `claim_issue`, and the lease
keeps the others off it. That is why the composed directive reports the project's agent
WIP limit, the cap on how many tickets one worker may hold at a time.
