---
title: "Idea discovery"
description: "A domain-agnostic research process for turning a domain description into a sequenced, falsification-tested list of buildable product ideas."
sidebar:
  order: 2
---
A prompt pattern for taking a one-paragraph domain description and working it through to
a sequenced, evidence-tested set of product ideas — without reconstructing the process
from scratch each time.

It's deliberately domain-agnostic: the steps below have been run on maritime data
businesses, but nothing in them is maritime-specific.

## Getting the directive

`get_playbook("idea-discovery")` returns this page verbatim — read it and adapt it by
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
