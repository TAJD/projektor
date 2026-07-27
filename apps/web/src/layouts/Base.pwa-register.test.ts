// Base.astro isn't a Preact component, so it can't be rendered with
// @testing-library/preact — this asserts directly on the source instead
// (see Base.mobile-viewport.test.ts for the same pattern).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "Base.astro"), "utf-8");
const configSource = readFileSync(join(__dirname, "../../astro.config.mjs"), "utf-8");

describe("Base layout — PWA service worker registration (PROJ-418)", () => {
	it("registers the service worker via the virtual:pwa-register module", () => {
		expect(source).toMatch(/import\s*\{\s*registerSW\s*\}\s*from\s*['"]virtual:pwa-register['"]/);
		expect(source).toMatch(/registerSW\(/);
	});

	it("disables vite-plugin-pwa's own (non-functional-on-Astro) auto-injection", () => {
		expect(configSource).toMatch(/injectRegister:\s*null/);
	});
});

// PROJ-430: the whole re-auth story (PROJ-427/#129's reload-on-401, and the
// sidebar Log in / Log out links) depends on a navigation reaching Cloudflare
// Access. A cache-first service worker that answers navigations locally makes
// every one of those paths inert — the session can never be refreshed.
describe("PWA service worker — navigations must reach the network (PROJ-430)", () => {
	it("does not precache HTML", () => {
		const globPatterns = configSource.match(/globPatterns:\s*\[([^\]]*)\]/)?.[1] ?? "";
		expect(globPatterns).not.toMatch(/html/);
	});

	// vite-plugin-pwa defaults navigateFallback to 'index.html', so this has to be
	// an explicit override — merely omitting the key leaves the fallback enabled.
	it("explicitly disables vite-plugin-pwa's default navigation fallback", () => {
		expect(configSource).toMatch(/navigateFallback:\s*undefined/);
	});

	it("keeps API and MCP traffic off the cache entirely", () => {
		expect(configSource).toMatch(/urlPattern:\s*\/\^\\\/\(\?:api\|mcp\)\\\/\//);
		expect(configSource).toMatch(/handler:\s*['"]NetworkOnly['"]/);
	});
});

// PROJ-431: the precache had grown to 4.17 MiB / 111 entries, dominated by chunks
// that are dynamically imported and reached by a minority of sessions (mermaid,
// cytoscape and katex render wiki diagrams and maths; the editor mounts only on Edit).
// They still load on demand — this only keeps them out of the install-time payload.
describe("PWA precache — keep the install payload small (PROJ-431)", () => {
	it("excludes the heavy dynamically-imported vendor chunks", () => {
		const globIgnores = configSource.match(/globIgnores:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
		for (const chunk of ["mermaid", "cytoscape", "katex", "MarkdownEditor", "Diagram-"]) {
			expect(globIgnores, `${chunk} should not be precached`).toContain(chunk);
		}
	});

	// The config patterns above are brittle to chunk renames; the byte budget asserted
	// against the built sw.js is the guard that actually holds. It runs as part of the
	// build (astro build && node scripts/assert-sw.mjs) because CI runs unit tests
	// before the build, so a dist-reading test here would just skip.
	it("enforces the precache budget from the build, against the built sw.js", () => {
		const pkg = JSON.parse(
			readFileSync(join(__dirname, "../../package.json"), "utf-8")
		) as { scripts: Record<string, string> };
		expect(pkg.scripts.build).toContain("scripts/assert-sw.mjs");
	});
});
