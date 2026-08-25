---
title: "Playbooks"
description: "Generic, reusable agent working patterns, shipped and served the same way projektor serves its own workflow spec — fetchable at the moment of use, with server-side parameterised composition."
sidebar:
  order: 0
---

A playbook is a generic, reusable working pattern — not specific to projektor's own
rules (that's [the workflow spec](/projektor/agents/workflow-spec/)), but a prompt
pattern for how an agent should approach a class of task.
[`epic-goal`](/projektor/agents/playbooks/epic-goal/) is a template for pointing an
agent at an epic and having it work autonomously to completion;
[`idea-discovery`](/projektor/agents/playbooks/idea-discovery/) is a research process
for turning a domain description into a sequenced list of product ideas.

## Why playbooks, not just prompts you copy-paste

The pattern that made [`workflow-spec`](/projektor/agents/workflow-spec/) work is
this: ship it as a plain TS constant in the codebase, serve it identically over MCP,
REST, and a CI-gated docs page, and point every entry point (the MCP `initialize`
instructions, this docs site) at that one source. Agents actually follow it across
long sessions because it's fetchable at the moment of use, not something they have
to remember from a system prompt written hours (or context compactions) earlier.
Playbooks apply the same idea to prompt *patterns* — reusable working styles, rather
than projektor-specific rules.

## Three ways to get one

**Fetch it raw** — `list_playbooks` to see what's available, `get_playbook(name)` for
the full template as markdown. Read it, adapt it, use it as-is.

**Have it composed for you** — `compose_playbook(name, params)` fills the template
server-side using live data the server already has and you'd otherwise have to look
up yourself. For `epic-goal`: pass an `epicRef` and the server fills in the epic's
actual title, how many child tickets are still open, and the project's agent WIP
limit — so the directive you get back is accurate to the moment you asked, not a
generic fill-in-the-blanks template.

**As a native prompt** — MCP clients that support the `prompts` primitive
(`prompts/list` / `prompts/get`) can surface a composable playbook as a slash command
— `epic-goal`'s optional arguments (`variant`, `reviewModel`, `cadence`) become a
form the client fills in, and `prompts/get` returns the same composed directive
`compose_playbook` would.

## What makes `epic-goal` flexible

It isn't one fixed prompt — `compose_playbook("epic-goal", params)` takes:

- **`epicRef`** *(required)* — which epic or ticket list to work through.
- **`variant`** — `bounded` (default: generated follow-on work is triaged and
  pruned, for delivery epics with a crisp outcome) or `full` (all generated work is
  actioned, for exploratory/quality epics where the discovered work *is* the point).
- **`reviewModel`** — which model runs the periodic adversarial review (default
  `opus`).
- **`cadence`** — how many completed tickets between review checkpoints (default 2).

Same template, four independent knobs, filled with data specific to your epic at
request time. See the full ingredient list and both template variants on the
[`epic-goal`](/projektor/agents/playbooks/epic-goal/) page.

## Available playbooks

| Playbook | What it's for |
|---|---|
| [`epic-goal`](/projektor/agents/playbooks/epic-goal/) | Work through an epic (or ticket list) autonomously until it's fully done. |
| [`idea-discovery`](/projektor/agents/playbooks/idea-discovery/) | Turn a domain description into a sequenced, falsification-tested list of product ideas. |

More will land here as they're extracted from real working sessions — the whole
point of a playbook is that it started as something that actually worked, not a
pattern designed in the abstract.
