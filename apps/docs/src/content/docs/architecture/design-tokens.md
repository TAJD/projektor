---
title: "Design tokens"
description: "The token contract behind Projektor's theming: what's safe to override, and what must never move."
sidebar:
  order: 3
---

Projektor's web UI (`apps/web`) is themed entirely through CSS custom properties defined
in `apps/web/src/styles/tokens.css`. There is no class-based dark mode and no
JS-driven restyle — light/dark and brand customisation are pure
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

Safe to override: `--accent` and `--on-accent` (see below), through the `BRAND_ACCENT`
and `BRAND_ON_ACCENT` deploy variables or a workspace's brand settings. Overriding a
semantic-fixed token directly is not supported; if a workspace genuinely needs a
different danger color, that's a product decision, not a theming one.

### Dividers and control edges

Borders come in two strengths. `--border` is the quiet line between regions and rows.
`--border-control` is the edge of something you type into or switch (text fields,
selects, the switch track), and is dark enough to meet the 3:1 non-text contrast floor
on both the page and a surface. A rule in `components.css` gives any text field or
select that asks for the plain border the control edge instead, so a new form control
gets the right one without opting in.

## `--on-accent` is set, not derived

`--light-on-accent` and `--dark-on-accent` are fixed values chosen per theme, not
derived from `--accent`: white on the light theme's accent, and a near-black teal
(`oklch(18% 0.03 205)`) on the dark theme's lighter accent, where white would fall to
2.28:1.

A custom accent arrives through `apps/web/src/utils/brand.ts`, which sets
`--light-accent` and `--dark-accent` to the brand colour and, when one is given, both
on-accent tokens to the brand's on-accent colour. Nothing computes the on-accent colour
from the accent. Pure CSS can't: relative color syntax
(`oklch(from var(--accent) l c h)`) can build a new color from another's channels, but
can't hand a channel back as a number to compare against a threshold. So whoever sets a
custom accent must also set its on-accent colour, and the same pair is used in both
themes. Deriving it in JS when the accent is set (pick black or white by WCAG relative
luminance) is the open improvement.

## Contrast

Measured against the default accents (light `oklch(52% 0.11 205)`, dark
`oklch(73% 0.12 205)`):

| Pair | Ratio | AA text (4.5:1) |
|---|---|---|
| light `--accent` vs `--light-on-accent` (white) | 5.08:1 | pass |
| dark `--accent` vs `--dark-on-accent` (near-black teal) | 8.21:1 | pass |

`apps/web/src/styles/tokens.contrast.test.ts` reads `tokens.css` and fails the build if
a palette change drops any of these below its floor, in both themes:

| What | Floor |
|---|---|
| Text on the accent (`--on-accent` on `--accent`) | 4.5:1 |
| Urgent, high and low priority chip text on its tinted chip | 4.5:1 |
| Danger text on the danger tint | 4.5:1 |
| Control borders (`--border-control`) on the page and on a surface | 3:1 |

`--on-accent` is used for button text, badges, the sidebar brand mark, the skip link and
the active item in the wiki tree. The test covers the shipped defaults only; a custom
brand pair is not checked.

## Reading tokens from JS

Canvas-rendered charts (`apps/web/src/islands/metrics/flow-charts.tsx`,
`apps/web/src/islands/MetricsDashboard.tsx`) can't use `var()` — canvas APIs need a
resolved color string. These read the live custom property via a `readThemeColor()`
helper with a literal fallback for the rare case the property isn't resolvable yet.
The fallback is a safety net, not a second source of truth — the token itself is
still what actually renders.

The four `--chart-seq-*` tokens are `color-mix()` expressions, and an *unregistered*
custom property's computed value is only var()-substituted, not fully resolved — so
`getComputedStyle` would hand the canvas an unresolved `color-mix(...)` string instead
of a color. `tokens.css` registers them with `@property { syntax: "<color>"; ... }` so
the UA resolves them to a real color at computed-value time before JS ever reads them.
