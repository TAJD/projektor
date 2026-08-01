# Design system: componentize shared primitives + cofferdam reuse checks

## Problem

`apps/web` has a real, fairly disciplined CSS-token layer (`--bg`, `--accent`,
`--priority-*`, etc., defined in `apps/web/src/layouts/Base.astro`) and a set
of shared visual primitives (`.btn`, `.badge`, `.select-*`,
`.account-menu-popover`, `.metric-help-popover`) — but they exist only as
global CSS classes applied by convention, documented nowhere but the newly
published `/wiki/design-system` page. Nothing stops a new island from
reimplementing a button, badge, or popover with a raw hex color and its own
one-off CSS instead of reusing what's there. A handful of existing files
already do this (see Current state below).

This spec covers (1) turning the primitives into real importable components,
migrating every current call site to them, and (2) a cofferdam plugin that
makes future drift a build failure instead of something only caught in
review.

## Current state (relevant code)

- `apps/web/src/layouts/Base.astro` (~lines 81–253): token definitions
  (`:root`, dark-mode media query, `[data-theme]` overrides) and
  (~lines 271–660+) global CSS for `.btn`, `.badge`, `.select-*`,
  `.metric-help-popover`, `.account-menu-*`.
- `apps/web/src/islands/Select.tsx`: the one primitive that's already a
  component, but implemented directly against `.select-*` classes rather
  than a shared abstraction other primitives can follow.
- Files using `.btn`/`.badge`/`.select-*`/popover classes directly (grepped
  2026-08-01, non-exhaustive — final list confirmed during implementation):
  `islands/AccountMenu.tsx`, `islands/issue-list/SavedViewsControl.tsx`,
  `islands/ShareView.tsx`, `islands/SprintManager.tsx`.
- Files with raw hex/`rgb()`/`rgba()` color literals (grepped 2026-08-01):
  `WikiPage.tsx`, `IssueDetailParts.tsx`, `IssueDetail.tsx`,
  `SprintManager.tsx`, `MetricsDashboard.tsx`, `metrics/flow-charts.tsx`,
  `issue-list/BoardView.tsx`, `issue-list/HeaderRow.tsx`,
  `issue-list/SprintBannerSection.tsx`, `issue-list/FiltersPopover.tsx`,
  `ApiHealth.tsx`. `MetricsDashboard.tsx`/`flow-charts.tsx` use these
  legitimately via a `readThemeColor()` helper (canvas can't read CSS custom
  properties) — hex there is a fallback value, not a violation. The rest are
  drift to fix during migration.
- `plugins/island-api/src/index.ts`: existing precedent for a repo-specific
  cofferdam plugin — a `defineCheck` from `@cofferdam/check-sdk`, registered
  via `cofferdam.toml`'s `plugins = ["./plugins/island-api"]`, scoped with
  `FileScope.pathPatterns`, combining a line-text regex scan and an
  AST `findAll` walk in one `run()`. The new plugin follows this pattern.

## Design

### 1. Component library — `apps/web/src/islands/ui/`

Four components, each wrapping the *existing* tokens/classes (no new visual
design, no new CSS):

- **`Button.tsx`** — wraps `.btn` + `.btn-primary`/`.btn-outline`/`.btn-danger`/`.btn-sm`.
- **`Badge.tsx`** — wraps `.badge`.
- **`Select.tsx`** — moved from `islands/Select.tsx` (import path updates at
  call sites; behavior unchanged).
- **`Popover.tsx`** — new: generalizes the duplicated positioning/border/
  shadow CSS currently hand-rolled three times (`.select-menu`,
  `.metric-help-popover`, `.account-menu-popover`). `MetricHelp.tsx` and
  `AccountMenu.tsx` migrate their popover markup onto this; `Select.tsx`'s
  dropdown may also use it if the shape lines up, but `Select` is not
  required to change its own internal popover if doing so complicates the
  keyboard-navigation logic — that call is deferred to implementation review,
  not decided here.

Each component's own file is exempt from the new cofferdam checks (see
below) — it's the one place allowed to reference raw class names / token
CSS, since it's the abstraction boundary.

### 2. Full migration

Every call site found in "Current state" above (plus any missed by the
2026-08-01 grep) moves to import from `islands/ui/`. Raw hex literals in the
non-canvas files get replaced with the matching `var(--*)` token as part of
the same change — most map directly (`"#fff"` in `HeaderRow.tsx` →
`var(--on-accent)`). This is a mechanical, file-by-file migration; no
behavior change, verified by existing `*.test.tsx` files continuing to pass
(component DOM structure/class output must stay stable — a constraint on the
component implementation, not new test-writing).

### 3. Cofferdam plugin — `plugins/design-system`

One check, id `DesignSystemConvention`, category `Warning`, severity `High`,
no baseline. `FileScope`: extensions `tsx`, `astro`; `pathPatterns:
["apps/web/src/**/*"]`; `excludePatterns: ["apps/web/src/layouts/Base.astro",
"apps/web/src/islands/ui/**/*"]`.

Four rules, one `run()`, distinct message per finding:

1. **Raw color literal** — line-scan regex for hex (`#[0-9a-fA-F]{3,8}\b`)
   and `rgb(`/`rgba(`. The two legitimate canvas-rendering files
   (`MetricsDashboard.tsx`, `metrics/flow-charts.tsx`) are **not**
   path-excluded — new raw hex added there still gets flagged unless the
   specific line carries an inline `// cofferdam-ignore:
   DesignSystemConvention` comment (same escape-hatch convention
   `island-api` already uses), so the exception stays scoped to the known
   `readThemeColor()` fallback lines rather than blanket-exempting the file.
2. **Hand-rolled primitive markup** — AST scan for JSX elements whose
   `className` (static string or simple template literal) contains one of
   the known primitive class tokens (`btn`, `badge`, `select-button`,
   `select-menu`, `account-menu-popover`, `metric-help-popover`) in a file
   that has no import from `islands/ui`.
3. **New primitive-shaped CSS class** — line-scan for `<style>` block
   contents (Astro) or CSS-in-JS outside the excluded paths defining a class
   selector whose name contains `btn`, `badge`, `popover`, `dropdown`, or
   `menu-`. Catches reimplementation under a new name that rule 2 can't see.
4. **Inline style with token-shaped values** — line-scan for `style={{`
   / `style="` containing `border-radius`, `padding`, or `box-shadow` values
   matching known primitive dimensions (`.btn`'s `4px` radius / `0.375rem
   0.75rem` padding; `.select-menu`'s `box-shadow: var(--shadow-sm)` shape —
   exact value list finalized during implementation from the current CSS).

Fixture test follows `plugins/island-api`'s pattern: `expected.json` +
`scripts/check-fixture.mjs`, covering at least one true positive and one
true negative per rule.

`cofferdam.toml` gains this plugin in its `plugins = [...]` array alongside
`./plugins/island-api`.

### Non-goals

- No new visual design — colors, spacing, and component behavior are
  unchanged; this is purely structural (componentize + enforce).
- No structural (AST shape-based) popover/dropdown-duplication check — the
  four rules above are class-name/literal/value based, not layout-pattern
  based; considered and deliberately deferred (higher build cost, false-
  positive risk against legitimate tooltips) per discussion.
- bestefforttools is explicitly out of scope for this effort, despite having
  a similar token-drift pattern (see `/wiki/ux-a11y-styling-review-2026-07`)
  — may be a follow-up if this pattern proves out here.

## Testing

- Existing `islands/**/*.test.tsx` for every migrated file must continue to
  pass unchanged (asserts component-output stability through the migration).
- New `plugins/design-system` gets its own fixture test (per `island-api`'s
  pattern) with true/false-positive cases for all four rules.
- After migration + plugin land, `cofferdam check` on `apps/web` should
  report zero `DesignSystemConvention` findings (clean baseline, matching
  the "error, no baseline" enforcement decision).
