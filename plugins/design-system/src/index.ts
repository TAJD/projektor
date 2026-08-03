// DesignSystemConvention — PROJ-527 (design-system epic).
//
// apps/web/src components must reuse islands/ui/* primitives and
// Base.astro's CSS tokens instead of drifting into ad-hoc markup/styles.
// Rules 1, 3, and 4 are line-scans; Rule 2 (import boundary) is AST-based.
// Only Rule 1 (raw color literal) is implemented here — Rules 2-4 land in
// later tasks (16-18).

import { Category, defineCheck, Severity } from "@cofferdam/check-sdk";

// Rule 2 is deliberately AST-based and per-primitive-family (NOT a
// whole-file "does this file import anything from islands/ui" gate) — a
// file-level gate goes permanently blind to every OTHER primitive family's
// findings once any one islands/ui import exists in that file. Confirmed
// by review.
const PRIMITIVE_FAMILIES: { pattern: RegExp; importedFrom: string; label: string }[] = [
  { pattern: /\bbtn\b/, importedFrom: "Button", label: "btn" },
  { pattern: /\bbadge\b/, importedFrom: "Badge", label: "badge" },
  { pattern: /\bselect-(button|menu|caret|option)\b/, importedFrom: "Select", label: "select-*" },
  {
    pattern: /\b(account-menu-popover|metric-help-popover|popover-account-menu|popover-metric-help|popover-select-menu)\b/,
    importedFrom: "Popover",
    label: "popover",
  },
];

const RAW_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g;
// A bare hex-shaped token isn't necessarily a color — href="#add" or
// id="#deed" are valid hex-digit strings but not colors. rgb(/rgba( are
// unambiguous alone; a bare #xxx only counts when the line also has a
// color-ish keyword nearby, or is unambiguously rgb/rgba. Confirmed
// necessary by review: the naive pattern false-positives on anchor hrefs.
const COLOR_CONTEXT_PATTERN = /(color|background|border|shadow|fill|stroke)/i;

const NEW_PRIMITIVE_CSS_CLASS_PATTERN = /\.[\w-]*(btn|badge|popover|dropdown|menu-)[\w-]*\s*\{/;

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

    if (file.ast) {
      const importedNames = new Set<string>();
      for (const imp of file.ast.findAll("ImportDeclaration")) {
        if (!/\/ui\/(Button|Badge|Select|Popover)$/.test(imp.source)) continue;
        for (const spec of imp.specifiers) importedNames.add(spec.imported ?? spec.localName);
      }
      for (const el of file.ast.findAll("JSXElement")) {
        const classAttr = el.attributes.find((a) => a.name === "class" || a.name === "className");
        if (!classAttr || classAttr.value === undefined) continue; // skip dynamic/expression class values
        for (const family of PRIMITIVE_FAMILIES) {
          if (!family.pattern.test(classAttr.value)) continue;
          if (importedNames.has(family.importedFrom)) continue;
          ctx.report({
            message: `Hand-rolled "${family.label}" markup — import ${family.importedFrom} from islands/ui instead of using the raw class.`,
            span: classAttr.span,
          });
        }
      }
    }

    for (const ln of file.lines()) {
      if (ln.isComment) continue;
      const m = NEW_PRIMITIVE_CSS_CLASS_PATTERN.exec(ln.text);
      if (!m) continue;
      ctx.report({
        message: `New primitive-shaped CSS class "${m[0].trim().replace(/\s*\{$/, "")}" — reuse or extend an existing islands/ui primitive's CSS instead of defining a new one.`,
        span: ln.spanFor(m.index, m.index + m[0].length),
      });
    }
  },
});
