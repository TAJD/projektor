// DesignSystemConvention — PROJ-527 (design-system epic).
//
// apps/web/src components must reuse islands/ui/* primitives and
// Base.astro's CSS tokens instead of drifting into ad-hoc markup/styles.
// Rules 1, 3, and 4 are line-scans; Rule 2 (import boundary) is AST-based.
// Only Rule 1 (raw color literal) is implemented here — Rules 2-4 land in
// later tasks (16-18).

import { Category, defineCheck, Severity } from "@cofferdam/check-sdk";

const RAW_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g;
// A bare hex-shaped token isn't necessarily a color — href="#add" or
// id="#deed" are valid hex-digit strings but not colors. rgb(/rgba( are
// unambiguous alone; a bare #xxx only counts when the line also has a
// color-ish keyword nearby, or is unambiguously rgb/rgba. Confirmed
// necessary by review: the naive pattern false-positives on anchor hrefs.
const COLOR_CONTEXT_PATTERN = /(color|background|border|shadow|fill|stroke)/i;

// cofferdam-ignore: Design.OrphanExport: loaded dynamically via cofferdam.toml's `plugins = ["./plugins/design-system"]`, not a static import
export default defineCheck({
  id: "DesignSystemConvention",
  category: Category.Warning,
  basePriority: 15,
  defaultSeverity: Severity.High,
  explanation:
    "apps/web/src components must reuse islands/ui/* primitives and Base.astro's " +
    "CSS tokens instead of raw color literals, hand-rolled button/badge/popover " +
    "markup, new primitive-shaped CSS classes, or inline styles matching known " +
    "primitive dimensions.",
  files: {
    extensions: ["tsx", "astro"],
    pathPatterns: ["apps/web/src/**/*"],
    // apps/web/src/pages/share/view.astro is a standalone, unauthenticated
    // page that intentionally does NOT render through Base.astro — it ships
    // its own minimal token block plus a .badge rule, the same
    // "token-definition source, not consumer" role Base.astro plays for the
    // rest of the app. Confirmed (Opus review): 28 raw-hex matches here are
    // all inside that self-contained token block, not drift.
    excludePatterns: [
      "apps/web/src/layouts/Base.astro",
      "apps/web/src/islands/ui/**/*",
      "apps/web/src/pages/share/view.astro",
    ],
  },
  run(file, ctx) {
    for (const ln of file.lines()) {
      if (ln.isComment) continue;
      for (const m of ln.text.matchAll(RAW_COLOR_PATTERN)) {
        const isUnambiguousRgb = m[0].startsWith("rgb");
        if (!isUnambiguousRgb && !COLOR_CONTEXT_PATTERN.test(ln.text)) continue;
        ctx.report({
          message: `Raw color literal "${m[0]}" — use a var(--*) token from Base.astro instead.`,
          span: ln.spanFor(m.index, m.index + m[0].length),
        });
      }
    }
  },
});
