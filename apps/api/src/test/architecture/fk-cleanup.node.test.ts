// PROJ-923: every foreign key declared with ON DELETE CASCADE / SET NULL must have
// matching explicit cleanup in the app, because D1 does not guarantee FK actions
// (PROJ-407, PROJ-918). This test parses packages/db/migrations for those FKs and checks
// each against FK_CLEANUP_ALLOWLIST:
//   - a new FK with no entry fails (add cleanup + an entry — see AGENTS.md);
//   - a `cleanedBy` entry must point at code that exists and mentions the child table
//     (snake_case or its drizzle camelCase name);
//   - an entry for an FK that no longer exists fails (keep the list honest).
//
// Runs in node (reads source off disk) — hence the .node.test.ts suffix.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FK_CLEANUP_ALLOWLIST } from "./fk-cleanup-allowlist";

const API_SRC = join(__dirname, "..", "..");
const MIGRATIONS = join(__dirname, "..", "..", "..", "..", "..", "packages", "db", "migrations");

function declaredFkActions(): Set<string> {
	const keys = new Set<string>();
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
		const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
		for (const stmt of sql.split(";")) {
			const table =
				/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[`"]?(\w+)[`"]?/i.exec(stmt) ??
				/ALTER TABLE\s+[`"]?(\w+)[`"]?\s+ADD/i.exec(stmt);
			if (!table) continue;
			const fk =
				/[`"]?\w+[`"]?\s+\w[^,]*?REFERENCES\s+[`"]?(\w+)[`"]?\s*\([^)]*\)[^,]*?ON DELETE\s+(CASCADE|SET NULL)/gi;
			for (const m of stmt.matchAll(fk)) {
				keys.add(`${table[1]} -> ${m[1]} (${m[2].toUpperCase()})`);
			}
		}
	}
	return keys;
}

// The source text of a top-level declaration (function or const): from its declaration
// line up to the next top-level declaration.
function declarationSource(ref: string): string | null {
	const [file, name] = ref.split("#");
	let text: string;
	try {
		text = readFileSync(join(API_SRC, file), "utf8");
	} catch {
		return null;
	}
	const start = new RegExp(
		`^(?:export )?(?:async )?(?:function\\s+${name}\\b|const\\s+${name}\\b)`,
		"m"
	).exec(text);
	if (!start) return null;
	const rest = text.slice(start.index + start[0].length);
	const next = /^(?:export |async function |function |const |let |type |interface )/m.exec(rest);
	return start[0] + (next ? rest.slice(0, next.index) : rest);
}

function camel(snake: string): string {
	return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe("PROJ-923: FK ON DELETE actions have explicit app cleanup", () => {
	const declared = declaredFkActions();

	it("parses the migrations (sanity)", () => {
		expect(declared.size).toBeGreaterThan(50);
		expect(declared.has("issue_comments -> issues (CASCADE)")).toBe(true);
	});

	it("every FK with ON DELETE has an allowlist entry", () => {
		const missing = [...declared].filter((k) => !(k in FK_CLEANUP_ALLOWLIST));
		expect(
			missing,
			"New FK with ON DELETE: D1 won't reliably run it. Clean up explicitly in the parent's delete path and add an entry to fk-cleanup-allowlist.ts (AGENTS.md: 'Deletes never rely on FK cascades')."
		).toEqual([]);
	});

	it("no allowlist entry for an FK that doesn't exist", () => {
		expect(Object.keys(FK_CLEANUP_ALLOWLIST).filter((k) => !declared.has(k))).toEqual([]);
	});

	it("every cleanedBy reference exists and mentions the child table", () => {
		const problems: string[] = [];
		for (const [key, entry] of Object.entries(FK_CLEANUP_ALLOWLIST)) {
			if (!("cleanedBy" in entry)) continue;
			const child = key.split(" -> ")[0];
			const sources = entry.cleanedBy.map((ref) => ({ ref, src: declarationSource(ref) }));
			for (const { ref, src } of sources)
				if (src === null) problems.push(`${key}: ${ref} not found`);
			const mentions = sources.every(
				({ src }) =>
					src !== null && (src.includes(child) || new RegExp(`\\b${camel(child)}\\b`).test(src))
			);
			if (!mentions)
				problems.push(`${key}: not every one of ${entry.cleanedBy.join(", ")} mentions ${child}`);
		}
		expect(problems).toEqual([]);
	});
});
