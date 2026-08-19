// PROJ-650: the release deploy's asset routing is invisible to every other test.
//
// `wrangler dev` and the workerd test runtime have no `[assets]` binding, so
// SELF.fetch() reaches the Worker for every path — a route can be fully covered
// by the suite and still 404 in production because Cloudflare served a static
// asset (or the SPA fallback) before the Worker ran. `run_worker_first` in the
// release config is the only thing that decides that, and it ships in a file no
// test reads. This asserts the prefixes the Worker must own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const RELEASE_WRANGLER = join(REPO_ROOT, "scripts", "release-assets", "wrangler.example.toml");

function runWorkerFirst(toml: string): string[] {
	const line = toml.split("\n").find((l) => l.trimStart().startsWith("run_worker_first"));
	if (!line) throw new Error("run_worker_first not found in the release wrangler config");
	const array = /\[(.*)\]/.exec(line)?.[1] ?? "";
	return array
		.split(",")
		.map((s) => s.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);
}

describe("release wrangler config", () => {
	const prefixes = runWorkerFirst(readFileSync(RELEASE_WRANGLER, "utf8"));

	// Each of these is a path the Worker answers and the asset handler must not
	// intercept. Removing one from run_worker_first breaks it only in production.
	it.each([
		["/api/*", "the REST API"],
		["/mcp/*", "the MCP endpoint"],
		["/wiki", "the legacy ?slug= redirect (PROJ-487)"],
		["/.well-known/*", "OAuth discovery metadata (RFC 9728 / RFC 8414)"],
	])("routes %s to the Worker first — %s", (prefix) => {
		expect(prefixes).toContain(prefix);
	});
});
