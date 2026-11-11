// D1 rejects a query with more than 100 bound parameters, and the vitest runner backs
// D1 with SQLite (cap 32766), so an un-chunked `inArray` passes every other test and
// only fails in production (AGENTS.md: "never bind a row-scaled array into one query").
// This test makes "forgot inChunks" a build failure.
//
// How it works (static, TypeScript compiler API, no execution):
//   1. Parse every src/services/*.ts file.
//   2. Find each `inArray(column, values)` call.
//   3. The call is fine if `values` is an array literal with no spread (fixed size), or
//      the call sits inside the callback passed to `inChunks`.
//   4. Anything else must be listed in IN_ARRAY_CHUNKING_ALLOWLIST with the reason its
//      array is bounded.
//
// Known limitation: it checks drizzle `inArray` only. A raw SQL `IN (...)` built by
// hand, or a chunk handed to a helper function, is not followed; the helper needs an
// allowlist entry.
//
// This runs in node (reads source off disk) — hence the .node.test.ts suffix.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { IN_ARRAY_CHUNKING_ALLOWLIST } from "./in-array-chunking-allowlist";

const SERVICES = join(import.meta.dirname, "..", "..", "services");

function isFunctionValue(node: ts.Expression | undefined): boolean {
	return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** "<file>#<function>" for every inArray call that is neither fixed-size nor chunked. */
function unchunkedInArrayCalls(file: string, text: string): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const found: string[] = [];

	const visit = (node: ts.Node, chunked: boolean, enclosing: string) => {
		let fn = enclosing;
		if (fn === "") {
			if (ts.isFunctionDeclaration(node) && node.name) fn = node.name.text;
			else if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				isFunctionValue(node.initializer)
			)
				fn = node.name.text;
		}

		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			if (node.expression.text === "inChunks") {
				node.arguments.forEach((arg, i) => {
					visit(arg, chunked || i === 1, fn);
				});
				return;
			}
			if (node.expression.text === "inArray" && !chunked) {
				const values = node.arguments[1];
				const fixedSize =
					values !== undefined &&
					ts.isArrayLiteralExpression(values) &&
					!values.elements.some(ts.isSpreadElement);
				if (!fixedSize) found.push(`${file}#${fn}`);
			}
		}
		ts.forEachChild(node, (child) => {
			visit(child, chunked, fn);
		});
	};

	visit(source, false, "");
	return found;
}

function scanServices(): Set<string> {
	const found = new Set<string>();
	for (const file of readdirSync(SERVICES)) {
		if (!file.endsWith(".ts") || file.includes(".test.")) continue;
		for (const key of unchunkedInArrayCalls(file, readFileSync(join(SERVICES, file), "utf8")))
			found.add(key);
	}
	return found;
}

describe("inArray calls stay under D1's 100-bound-parameter cap", () => {
	it("detects an un-chunked call and accepts chunked and fixed-size ones (sanity)", () => {
		const sample = `
			async function bad(ids: string[]) { return q.where(inArray(t.id, ids)); }
			async function spread(ids: string[]) { return q.where(inArray(t.id, [...ids])); }
			async function chunked(ids: string[]) {
				return inChunks(ids, (chunk) => q.where(inArray(t.id, chunk)));
			}
			async function fixed() { return q.where(inArray(t.status, ["a", "b"])); }
		`;
		expect(unchunkedInArrayCalls("sample.ts", sample)).toEqual([
			"sample.ts#bad",
			"sample.ts#spread",
		]);
	});

	it("every un-chunked inArray in services has an allowlist entry", () => {
		const missing = [...scanServices()].filter((key) => !(key in IN_ARRAY_CHUNKING_ALLOWLIST));
		expect(
			missing,
			"Un-chunked inArray: D1 rejects more than 100 bound parameters. Wrap the query in inChunks (services/sql.ts), or, if the array is provably bounded, add an entry with the reason to in-array-chunking-allowlist.ts."
		).toEqual([]);
	});

	it("no allowlist entry for a call that no longer exists", () => {
		const found = scanServices();
		expect(Object.keys(IN_ARRAY_CHUNKING_ALLOWLIST).filter((key) => !found.has(key))).toEqual([]);
	});
});
