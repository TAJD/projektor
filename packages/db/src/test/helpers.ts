import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

// Mirrors apps/api/src/test/migrations.ts's statement splitting: DatabaseSync.exec()
// runs one statement at a time, and comments/semicolons in Drizzle's SQL output would
// otherwise produce spurious empty fragments.
function splitStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function loadMigrations(): string[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
}

/** A fresh in-memory SQLite DB with every migration applied in order, FK enforcement on. */
export function migratedDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON;");
	for (const sql of loadMigrations()) {
		for (const stmt of splitStatements(sql)) {
			// node:sqlite's bundled build doesn't consistently ship the fts5 module
			// across Node patch versions; production D1/Cloudflare sqlite does.
			// Skip fts5-dependent statements here rather than gate tests on it.
			if (/\bfts5\b/i.test(stmt) || /\b(issues|wiki)_fts\b/i.test(stmt)) continue;
			db.exec(stmt);
		}
	}
	return db;
}
