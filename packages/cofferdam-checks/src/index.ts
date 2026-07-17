// IslandApiBoundary — cofferdam port of scripts/check-island-api.sh.
//
// Islands must call the API through apiFetch/buildHeaders in
// apps/web/src/utils/api-client.ts, not via a raw fetch() or a locally
// redeclared buildHeaders. Scoped to apps/web/src/islands via
// FileScope.pathPatterns.
//
// Pattern A (line walk) rather than an AST findAll pass: the original
// bash script was regex-based, so this ports directly with no loss of
// precision, and avoids needing declaration-site AST nodes (the v0
// AstView union has no VariableDeclaration kind, so `const buildHeaders
// = ...` isn't directly detectable via findAll anyway).

import { Category, defineCheck, Severity } from "@cofferdam/check-sdk";

const BUILD_HEADERS_DECL = /\b(function\s+buildHeaders|const\s+buildHeaders)\b/;
// Matches a bare `fetch(` call, not `apiFetch(` or `window.fetch(` - mirrors
// the original script's `[^a-zA-Z0-9_.]fetch\(` grep.
const RAW_FETCH_CALL = /(?:^|[^a-zA-Z0-9_.])fetch\(/;

export default defineCheck({
	id: "IslandApiBoundary",
	category: Category.Warning,
	basePriority: 15,
	defaultSeverity: Severity.High,
	explanation:
		"Islands must call the API through apiFetch/buildHeaders in " +
		"apps/web/src/utils/api-client.ts. A raw fetch() or a locally " +
		"redeclared buildHeaders skips the shared auth headers, credentials, " +
		"and error handling every other island relies on.",
	files: {
		extensions: ["ts", "tsx"],
		// NOTE: a trailing `dir/**` never matches a direct file in this
		// matcher (its `(?:.+/)?` suffix requires the remainder to end in
		// `/`) - it only matches recursively-nested paths. `dir/**/*` covers
		// both direct children and nested ones.
		pathPatterns: ["apps/web/src/islands/**/*"],
	},
	run(file, ctx) {
		for (const ln of file.lines()) {
			if (ln.isComment || ln.isDocComment) continue;

			const headersMatch = BUILD_HEADERS_DECL.exec(ln.text);
			if (headersMatch) {
				ctx.report({
					message:
						"Local buildHeaders declared in an island - remove it and import buildHeaders from utils/api-client.ts instead.",
					span: ln.spanFor(headersMatch.index, headersMatch.index + headersMatch[0].length),
				});
			}

			const fetchMatch = RAW_FETCH_CALL.exec(ln.text);
			if (fetchMatch) {
				const start = fetchMatch[0].startsWith("fetch(") ? fetchMatch.index : fetchMatch.index + 1;
				ctx.report({
					message:
						"Raw fetch() found in an island - use apiFetch from utils/api-client.ts instead.",
					span: ln.spanFor(start, start + "fetch(".length),
				});
			}
		}
	},
});
