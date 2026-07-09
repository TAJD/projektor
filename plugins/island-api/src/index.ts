// IslandApiConvention — port of scripts/check-island-api.sh (CD-69).
//
// islands must not declare their own `buildHeaders` and must not call
// the raw `fetch` global — both should go through `apiFetch` in
// apps/web/src/utils/api-client.ts.
//
// Design intent:
//   - `buildHeaders` detection stays a line-text scan, not an AST match.
//     The check-sdk v0 AST surface has no VariableDeclaration kind (see
//     CD-78), so `const buildHeaders = (...) => {}` is invisible to
//     `findAll` — only `function buildHeaders(){}` would be reachable
//     via the `Function` kind. A line scan catches both forms, matching
//     the original grep's behavior.
//   - The scan does not skip `LineView.isComment` OR `isStringLiteral`
//     lines: `isComment` is true for any line a comment overlaps at
//     all, including ordinary code with a trailing `// note`, and
//     `isStringLiteral` is true for any line a string/template literal
//     touches — a single-line declaration like
//     `const buildHeaders = () => ({ "Content-Type": "json" })` has a
//     string literal on the same line as the real declaration, so
//     skipping it would silently swallow a common header-builder shape.
//     The original grep excluded neither, so not filtering on either
//     flag keeps parity rather than regressing coverage.
//   - Raw fetch() detection is AST-based: bare `fetch(...)` calls, plus
//     `window.fetch` / `globalThis.fetch` / `self.fetch` — a deliberate
//     widening over the original grep, which only matched bare fetch
//     (its exclusion of `.` before `fetch(` let `window.fetch(...)`
//     through undetected).

import { Category, defineCheck, Severity, type AstNode } from "@cofferdam/check-sdk";

const BUILD_HEADERS_PATTERN = /\b(function|const)\s+buildHeaders\b/;
const GLOBAL_FETCH_OBJECTS = new Set(["window", "globalThis", "self"]);

export default defineCheck({
  id: "IslandApiConvention",
  category: Category.Warning,
  basePriority: 15,
  defaultSeverity: Severity.High,
  explanation:
    "Islands must go through the shared apiFetch wrapper (auth headers, " +
    "error handling) instead of declaring their own header builder or " +
    "calling fetch() directly.",
  files: {
    extensions: ["ts", "tsx"],
    // "apps/web/src/islands/**" (no trailing `/*`) never matches a file
    // directly inside islands/ — only nested subdirectories — because of
    // the glob bug tracked as CD-70. `**/*` is the workaround: it
    // matches both direct files and nested ones.
    pathPatterns: ["apps/web/src/islands/**/*"],
  },
  run(file, ctx) {
    for (const ln of file.lines()) {
      const m = BUILD_HEADERS_PATTERN.exec(ln.text);
      if (!m) continue;
      ctx.report({
        message: 'Local "buildHeaders" declared here — use apiFetch from utils/api-client.ts instead.',
        span: ln.spanFor(m.index, m.index + m[0].length),
      });
    }

    if (!file.ast) return;

    for (const call of file.ast.findAll("CallExpression")) {
      const flagged = describeRawFetchCallee(call.callee);
      if (!flagged) continue;
      ctx.report({
        message: `Raw "${flagged}" call — use apiFetch from utils/api-client.ts instead.`,
        span: call.span,
      });
    }
  },
});

/**
 * Returns a display string (e.g. `"fetch()"`, `"window.fetch()"`) when
 * `callee` is a call to the raw fetch global, `null` otherwise.
 */
function describeRawFetchCallee(callee: AstNode): string | null {
  if (callee.kind === "IdentifierReference" && callee.name === "fetch") {
    return "fetch()";
  }
  if (
    callee.kind === "MemberExpression" &&
    callee.property === "fetch" &&
    callee.object.kind === "IdentifierReference" &&
    GLOBAL_FETCH_OBJECTS.has(callee.object.name)
  ) {
    return `${callee.object.name}.fetch()`;
  }
  return null;
}
