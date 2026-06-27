import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
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
