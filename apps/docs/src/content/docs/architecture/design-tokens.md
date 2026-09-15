---
title: "Design tokens"
description: "The token contract behind Projektor's theming: what's safe to override, and what must never move."
sidebar:
  order: 3
---

Projektor's web UI (`apps/web`) is themed entirely through CSS custom properties defined
in `apps/web/src/styles/tokens.css`. There is no class-based dark mode and no
JS-driven restyle — light/dark and (eventually) brand customisation are pure
custom-property swaps that CSS resolves on its own.

## Two kinds of token

Every token in `tokens.css` falls into one of two categories:

**Brand-derived** — follows `--accent`. Expressed as
`color-mix(in oklab, var(--accent) N%, transparent)` (translucent tints) or
`color-mix(in oklch, white/black P%, var(--accent) Q%)` (opaque tints and the chart
lightness ramp), never as a hand-written hex or `rgba()`. Setting a different accent
should visibly rebrand every token in this category with no further edits.

Examples: `--priority-medium-*`, `--status-in-progress`, `--sprint-active-*`,
`--sprint-notice-*`, `--dropzone-bg`, `--velocity-bar-bg`, `--chart-seq-1` through
`--chart-seq-4`.

**Semantic-fixed** — never follows brand. Danger red, done green, warning amber, and
the urgent/high priority colors stay put regardless of accent — a green "urgent" badge
is a bug, not a customisation.

Examples: `--danger-*`, `--warning-*`, `--success-*`, `--status-done`,
`--status-cancelled`, `--priority-urgent-*`, `--priority-high-*`.

Safe to override at any customisation layer: `--accent` itself, and — once a
future layer exposes it — `--on-accent` (see below). Overriding a semantic-fixed token
directly is not supported; if a workspace genuinely needs a different danger color,
that's a product decision, not a theming one.

## `--on-accent` is currently static

`--light-on-accent` / `--dark-on-accent` are fixed per-theme values (`#fff`), not
derived from `--accent`. A real derivation needs to pick black or white text based on
the accent's actual lightness so a pale custom brand colour doesn't render white-on-white.

This can't be done in reliable, broadly-supported pure CSS: relative color syntax
(`oklch(from var(--accent) l c h)`) can build a *new* color out of an existing one's
channels, but it can't hand you a channel back as a free-standing number for a
`calc()`/threshold comparison. The derivation has to happen in JS, at the point a
custom accent is actually set:

1. Compute the new accent's relative luminance (WCAG formula).
2. Pick black or white — whichever gives the higher contrast ratio, or apply the
   standard ~0.5 relative-luminance threshold.
3. Set both `--accent` and the computed `--on-accent` as inline styles on `<html>`
   alongside each other.

This lands with whichever customisation layer first lets someone set a custom accent
(self-hoster/workspace/user branding). Until then, the static value is correct because
the only accents in use are the two shipped theme defaults, both already verified
against white text (see below).

## Contrast

Measured against the current default accents (light `#4f46e5`, dark `#6366f1`):

| Pair | Ratio | AA (4.5:1) |
|---|---|---|
| light `--accent` vs `--light-on-accent` (white) | 6.29:1 | pass |
| dark `--accent` vs `--dark-on-accent` (white) | 4.47:1 | pass (marginal) |
| light `--priority-medium-text` (= accent) vs `--light-surface` | 6.01:1 | pass |
| dark `--priority-medium-text` (55% white / 45% accent mix) vs `--dark-surface` | 8.92:1 | pass |

The dark on-accent ratio is the tightest of the set. It isn't something this token
split changes — it's inherent to the shipped dark accent color — but it's worth
keeping in mind if the dark accent itself ever moves.

## Reading tokens from JS

Canvas-rendered charts (`apps/web/src/islands/metrics/flow-charts.tsx`,
`apps/web/src/islands/MetricsDashboard.tsx`) can't use `var()` — canvas APIs need a
resolved color string. These read the live custom property via a `readThemeColor()`
helper with a literal fallback for the rare case the property isn't resolvable yet.
The fallback is a safety net, not a second source of truth — the token itself is
still what actually renders.
