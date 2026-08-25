// Single source of truth for shipped agent playbooks — generic, reusable working
// patterns (as opposed to workflow-content.ts, which is projektor's own state-machine
// rules). Consumed via list_playbooks/get_playbook (services/playbooks.ts) and
// GET /api/playbooks[/:name]. PROJ-601 adds a scripts/gen-playbooks.ts that renders
// these into docs-site pages with a CI staleness gate, the same pattern used for
// workflow-spec.md (see scripts/gen-workflow-spec.ts) — sidebarOrder below exists for
// that consumer.
//
// Kept as a plain TS constant (not a `?raw` markdown import) for the same reason as
// WORKFLOW_SPEC: identical loading under tsx, vitest, and the wrangler/esbuild release
// bundle.
export interface Playbook {
	name: string;
	title: string;
	description: string;
	whenToUse: string;
	sidebarOrder: number;
	body: string;
}

// The individual template clauses, factored out so services/playbook-compose.ts can
// fill and assemble the same wording that PLAYBOOKS' prose body documents below —
// one source for both the human-readable doc and the machine-composed directive.
export const EPIC_GOAL_TEMPLATE = {
	goal: "**Goal:** work through {EPIC} autonomously until it is fully done.",
	auditFirst:
		"**Audit first:** before implementing anything, audit origin/main, open PRs, and local " +
		"worktree state so already-finished or in-flight work is folded in, not redone.",
	loop:
		"**Loop:** pick the next open ticket on the epic (`get_prioritized_issues`), implement " +
		"it, verify (tests/build), commit, close the ticket, move on.",
	selfFeed: {
		bounded:
			"**Self-feed (bounded):** file tickets for bugs, improvements, and follow-on features you " +
			"discover and link them to the epic — but only action ones that block or directly improve " +
			"the epic's outcome. Park everything else in the backlog untriaged. At each review " +
			"checkpoint, have the reviewer rank the parked tickets and drop any not worth keeping.",
		full:
			"**Self-feed (full):** file tickets for bugs, improvements, and follow-on features you " +
			"discover, link them to the epic, and action them in the same loop — the goal covers " +
			"generated work, not just the original tickets.",
	},
	reviewCadence:
		"**Review cadence:** after every {N} completed tickets, run an adversarial {MODEL} review " +
		"of the accumulated diff; file and fix anything it finds before continuing.",
	doneWhen: {
		bounded:
			"**Done when:** every ticket on the epic (original + actioned generated) is closed, " +
			"verification is green, and everything is committed and pushed.",
		full:
			"**Done when:** every ticket on the epic (original + generated) is closed, verification " +
			"is green, and everything is committed and pushed.",
	},
	decisionsLog:
		"**Decisions log:** instead of asking questions, make the call and record decisions, " +
		"tradeoffs, and anything needing human judgment as comments on the epic for review at the " +
		"end. If two reasonable implementations diverge, comment both options on the ticket, pick " +
		"the simpler, and flag it.",
} as const;

export const PLAYBOOKS: Playbook[] = [
	{
		name: "epic-goal",
		title: "Epic-driven autonomous goals",
		description:
			"Compose a standing goal directive for autonomously working an epic (or ticket list) to completion.",
		whenToUse:
			'Starting an autonomous run over an epic or list of tickets — "work through this epic", ' +
			'"implement these tickets and keep going". Two variants: bounded (default — generated work ' +
			"is triaged and pruned) and full (all generated work is actioned).",
		sidebarOrder: 1,
		body: `A prompt pattern for pointing an agent at an epic (or ticket list) and having it work
autonomously until everything — including work it discovers along the way — is done.

It's deliberately generic. [The workflow spec](/projektor/agents/workflow-spec/) is the
projektor-specific half — definition of ready, the status state machine, human review
gates, fleet coordination rules. This playbook is the shape of the *run* that drives
those rules, so an agent working an epic normally fetches both.

## Getting the directive

\`get_playbook("epic-goal")\` returns this page verbatim, template and all — read it and
adapt it by hand.

\`compose_playbook("epic-goal", { epicRef, variant, reviewModel, cadence })\` returns just
the directive, with every placeholder already filled from data the server holds:

| Parameter / source | Fills |
|---|---|
| \`epicRef\` *(required)* — resolved to the epic's ref and title | the **Goal** clause |
| \`variant\` — \`bounded\` (default) or \`full\` | the **Self-feed** and **Done when** clauses |
| \`cadence\` (default 2) and \`reviewModel\` (default \`opus\`) | the **Review cadence** clause |
| the epic's open child count and the project's agent WIP limit | an extra **Live data** clause |

MCP clients that support the \`prompts\` primitive surface the same composed directive as a
slash command, with the three optional parameters as prompt arguments.

## What each clause is for

- **Goal** — a concrete entry point (an epic ref, not a prose description) plus an explicit
  autonomy grant. Without the grant a run tends to stop after the first ticket to ask
  what's next.
- **Audit first** — on a resumed run, an agent that doesn't look first repeats work that
  is already merged to origin/main or sitting in an open PR. This is also the clause that
  matters most after a context compaction, when the agent's memory of the run is gone but
  the directive isn't.
- **Loop** — \`get_prioritized_issues\` chooses the next ticket rather than the agent, so
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

> ${EPIC_GOAL_TEMPLATE.goal}
>
> ${EPIC_GOAL_TEMPLATE.auditFirst}
>
> ${EPIC_GOAL_TEMPLATE.loop}
>
> ${EPIC_GOAL_TEMPLATE.selfFeed.bounded}
>
> ${EPIC_GOAL_TEMPLATE.reviewCadence}
>
> ${EPIC_GOAL_TEMPLATE.doneWhen.bounded}
>
> ${EPIC_GOAL_TEMPLATE.decisionsLog}

## Template — full variant

Same as bounded, with the self-feed clause replaced by:

> ${EPIC_GOAL_TEMPLATE.selfFeed.full}

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
hands out the tickets: each worker takes its own through \`claim_issue\`, and the lease
keeps the others off it. That is why the composed directive reports the project's agent
WIP limit, the cap on how many tickets one worker may hold at a time.
`,
	},
	{
		name: "idea-discovery",
		title: "Idea discovery",
		description:
			"A domain-agnostic research process for turning a domain description into a sequenced, " +
			"falsification-tested list of buildable product ideas.",
		whenToUse:
			'Exploring a new domain or application area for viable products — "what could we build ' +
			'in X", "find gaps in Y" — before committing to any single idea. Best when the founder is ' +
			"solo/technical, favours free data sources, and needs a clear distribution channel per idea.",
		sidebarOrder: 2,
		body: `A prompt pattern for taking a one-paragraph domain description and working it through to
a sequenced, evidence-tested set of product ideas — without reconstructing the process
from scratch each time.

It's deliberately domain-agnostic: the steps below have been run on maritime data
businesses, but nothing in them is maritime-specific.

## Getting the directive

\`get_playbook("idea-discovery")\` returns this page verbatim — read it and adapt it by
hand, filling in the domain description.

## Input

A one-paragraph description of the domain or application area to explore.

## Constraints applied throughout

- **Free/open data sources only** — verify licences permit commercial reuse before relying
  on a source. A promising idea built on a data source you can't legally use commercially
  is not a promising idea.
- **Every idea needs a clear distribution channel** — a press cycle, SEO, an existing
  community, or a developer channel. An idea with no plausible way to reach users is not
  worth qualifying further, however novel.
- **Solo technical founder** — favour products buildable as an app or API on serverless
  infrastructure. Ideas that need a team, capital, or bespoke infra to stand up don't fit
  the constraint and should be discarded early, not qualified.

## Steps

Web search at every stage. Pause for a decision at each transition — don't run straight
through to idea generation without confirming the frontier, assets, and landscape are
right.

1. **Research frontier** — recent advances (roughly the last 3 years) in the domain's
   literature. Skip this step entirely if the domain isn't research-driven.
2. **Assets** — open datasets, records, feeds, and registries available in the domain;
   their licences; what can be inferred from them beyond their stated purpose.
3. **Landscape** — incumbents in tiers (raw data providers → enterprise intelligence →
   vertical tools), with pricing. Note who is served at what price point, and who isn't
   served at all.
4. **Gap hypotheses** — propose gaps between what the landscape serves and what the
   assets/frontier make possible, then actively try to falsify each one with further
   searches. Report kills explicitly — a dead hypothesis is progress, not a wasted step.
5. **Idea generation** — batches of roughly 10 ideas. Each idea gets exactly three
   attributes: novelty, free data source(s) it relies on, and its distribution channel.
   No idea without all three.
6. **Qualification** — for ideas on the shortlist: product shape, user story, similar
   existing products, and the unserved niche it targets. Then pressure-test the
   load-bearing assumption — usually licensing, legal exposure, or moat — the one
   assumption that kills the idea if it's wrong.
7. **Sequencing** — a build order that exploits shared infrastructure across ideas (a
   dataset pipeline or API client one idea needs is often reusable by the next). Name the
   cheapest first experiment explicitly.

## Principles

- **Cheap evidence before commitment** — a falsifying search costs minutes; a shipped
  product costs weeks. Spend the cheap evidence first.
- **Be honest when a space is saturated** — a landscape step that finds five well-funded
  incumbents at every price tier is a valid, useful outcome. Don't force a gap that isn't
  there.
- **Desk validation is not buyer validation** — qualification and sequencing narrow the
  field on desk research alone. They are not a substitute for talking to a real buyer
  before building.
`,
	},
];
