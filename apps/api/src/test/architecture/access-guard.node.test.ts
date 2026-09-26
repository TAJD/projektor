// PROJ-837: every exported service operation that takes a project-scoped entity id
// must reach the central access guard (services/access.ts) — directly, or through a
// helper that does.
//
// Why: PROJ-792 (share links), 794, 818 and 822 were all the same bug — a service
// that hand-rolled its project check and forgot it, or never had one. A per-service
// review can't keep up with the number of services; this test makes "forgot the
// guard" a build failure instead of a security report.
//
// How it works (static, TypeScript compiler API, no execution):
//   1. Parse every src/services/*.ts file.
//   2. Build a call graph of top-level functions, resolving `./x` imports across files.
//   3. A function is GUARDED if it calls a guard from services/access.ts, or calls
//      (transitively) a function that is guarded.
//   4. An exported function is a TARGET if its first parameter is `ctx` and another
//      parameter names a project-scoped entity (issueId, projectId, pageId, …; or a
//      bare `id`/`slug` in a project-scoped domain file).
//   5. Every target must be guarded, or be listed in ALLOWLIST with a reason.
//
// Known limitation: operations that take `input: unknown` and parse the id out of it
// are not detected by parameter name. PROJ-896 moves this onto the operation
// registry's `projectScoped` flag, which removes the heuristic.
//
// This runs in node (reads source off disk) — hence the .node.test.ts suffix.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ACCESS_GUARD_ALLOWLIST } from "./access-guard-allowlist";

const SERVICES = join(import.meta.dirname, "..", "..", "services");

/** Exports of services/access.ts that actually decide access (not pure predicates). */
const GUARDS = new Set([
	"assertProjectAccess",
	"hasProjectAccess",
	"visibleProjectFilter",
	"requireProjectAccess",
	"effectiveProjectRole",
	"visibleProjectPredicate",
	"visibleProjectSqlFragment",
	"visibleProjectIds",
]);

const ENTITY_PARAM = /^(issueId|projectId|sprintId|pageId|wikiPageId|parentId|issueRef)$/;
const GENERIC_ID_PARAM = /^(id|idOrSlug|slug|pageIdOrSlug|ref)$/;
const PROJECT_SCOPED_FILES = new Set([
	"issues",
	"sprints",
	"wiki",
	"wiki-drafts",
	"wiki-watchers",
	"wiki-links",
	"wiki-export",
	"projects",
	"share",
	"comments",
	"issue-links",
]);

interface FnInfo {
	file: string;
	name: string;
	exported: boolean;
	params: string[];
	calls: string[]; // resolved keys "file:name", or "guard:<name>"
}

function paramName(p: ts.ParameterDeclaration): string {
	return ts.isIdentifier(p.name) ? p.name.text : "";
}

function collect(): Map<string, FnInfo> {
	const fns = new Map<string, FnInfo>();
	const files = readdirSync(SERVICES).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

	for (const fileName of files) {
		const file = fileName.replace(/\.ts$/, "");
		const src = ts.createSourceFile(
			fileName,
			readFileSync(join(SERVICES, fileName), "utf8"),
			ts.ScriptTarget.Latest,
			true
		);

		// import name → "file:name" (or "guard:name" for access.ts guards)
		const imports = new Map<string, string>();
		const locals: Array<{ name: string; node: ts.Node; exported: boolean; params: string[] }> = [];

		for (const stmt of src.statements) {
			if (
				ts.isImportDeclaration(stmt) &&
				ts.isStringLiteral(stmt.moduleSpecifier) &&
				stmt.moduleSpecifier.text.startsWith("./")
			) {
				const from = stmt.moduleSpecifier.text.slice(2);
				const named = stmt.importClause?.namedBindings;
				if (named && ts.isNamedImports(named)) {
					for (const el of named.elements) {
						const orig = (el.propertyName ?? el.name).text;
						imports.set(
							el.name.text,
							from === "access" && GUARDS.has(orig) ? `guard:${orig}` : `${from}:${orig}`
						);
					}
				}
			}
			const exported = !!ts
				.getModifiers(stmt as ts.HasModifiers)
				?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
			if (ts.isFunctionDeclaration(stmt) && stmt.name) {
				locals.push({
					name: stmt.name.text,
					node: stmt,
					exported,
					params: stmt.parameters.map(paramName),
				});
			} else if (ts.isVariableStatement(stmt)) {
				for (const d of stmt.declarationList.declarations) {
					if (
						ts.isIdentifier(d.name) &&
						d.initializer &&
						(ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
					) {
						locals.push({
							name: d.name.text,
							node: d.initializer,
							exported,
							params: d.initializer.parameters.map(paramName),
						});
					}
				}
			}
		}

		const localNames = new Set(locals.map((l) => l.name));
		for (const l of locals) {
			const calls: string[] = [];
			const visit = (n: ts.Node) => {
				// Any reference counts (call, or passed as a callback / predicate).
				if (ts.isIdentifier(n) && n !== (l.node as ts.FunctionDeclaration).name) {
					const id = n.text;
					if (file === "access" && GUARDS.has(id)) calls.push(`guard:${id}`);
					else if (localNames.has(id)) calls.push(`${file}:${id}`);
					else if (imports.has(id)) calls.push(imports.get(id) as string);
				}
				ts.forEachChild(n, visit);
			};
			ts.forEachChild(l.node, visit);
			fns.set(`${file}:${l.name}`, {
				file,
				name: l.name,
				exported: l.exported,
				params: l.params,
				calls,
			});
		}
	}
	return fns;
}

function guardedSet(fns: Map<string, FnInfo>): Set<string> {
	const guarded = new Set<string>();
	for (const g of GUARDS) guarded.add(`access:${g}`);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [key, fn] of fns) {
			if (guarded.has(key)) continue;
			if (fn.calls.some((c) => c.startsWith("guard:") || guarded.has(c))) {
				guarded.add(key);
				changed = true;
			}
		}
	}
	return guarded;
}

function isTarget(fn: FnInfo): boolean {
	if (!fn.exported || fn.file === "access") return false;
	if (fn.params[0] !== "ctx") return false;
	const rest = fn.params.slice(1);
	if (rest.some((p) => ENTITY_PARAM.test(p))) return true;
	return PROJECT_SCOPED_FILES.has(fn.file) && rest.some((p) => GENERIC_ID_PARAM.test(p));
}

describe("PROJ-837: project-scoped service operations reach the access guard", () => {
	const fns = collect();
	const guarded = guardedSet(fns);
	const targets = [...fns.entries()].filter(([, fn]) => isTarget(fn));

	it("finds the operations it is meant to police (the heuristic isn't silently empty)", () => {
		expect(targets.length).toBeGreaterThan(20);
		expect(targets.map(([k]) => k)).toContain("share:createShareToken");
	});

	it("every target calls the guard, directly or through a helper", () => {
		const unguarded = targets
			.filter(([key]) => !guarded.has(key) && !(key in ACCESS_GUARD_ALLOWLIST))
			.map(([key]) => key)
			.sort();
		expect(
			unguarded,
			"These exported services take a project-scoped id but never reach services/access.ts. " +
				"Call assertProjectAccess/hasProjectAccess (or a helper that does), or — if the " +
				"function is genuinely safe — add it to test/architecture/access-guard-allowlist.ts with a reason."
		).toEqual([]);
	});

	it("allowlist entries are live: each names a real target that is still unguarded", () => {
		const stale = Object.keys(ACCESS_GUARD_ALLOWLIST).filter((key) => {
			const fn = fns.get(key);
			return !fn || !isTarget(fn) || guarded.has(key);
		});
		expect(stale, "Remove these allowlist entries — they no longer need an exception").toEqual([]);
	});

	it("regression: share create/revoke are guarded (PROJ-792)", () => {
		expect(guarded.has("share:createShareToken")).toBe(true);
		expect(guarded.has("share:revokeShareToken")).toBe(true);
	});
});
