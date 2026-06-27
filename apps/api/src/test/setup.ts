import { env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import { MIGRATIONS } from "./migrations";

// Strip line comments before splitting on ; — Drizzle breakpoints and any
// semicolons inside comments (e.g. "ON CONFLICT; old windows are") would
// otherwise produce spurious fragments. prepare().run() is used per statement
// because Miniflare's exec() doesn't handle multi-statement SQL.
function splitStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

beforeAll(async () => {
	for (const sql of MIGRATIONS) {
		for (const stmt of splitStatements(sql)) {
			await env.DB.prepare(stmt).run();
		}
	}
});

// @cloudflare/vitest-pool-workers ≥0.13 isolates storage per *file*, not per
// *test* (the old `isolatedStorage` per-test rollback was removed). The transient
// rate-limit counter therefore accumulates across tests in a file and trips the
// low test limits (AUTH_LIMIT=3). Reset it before each test so every test starts
// from a clean window — restoring the per-test freshness the old isolation gave.
beforeEach(async () => {
	await env.DB.prepare("DELETE FROM rate_limit").run();
});
