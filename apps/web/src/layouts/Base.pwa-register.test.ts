// Base.astro isn't a Preact component, so it can't be rendered with
// @testing-library/preact — this asserts directly on the source instead
// (see Base.mobile-viewport.test.ts for the same pattern).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Plain .mjs build helper, shared with astro.config.mjs; typed by its JSDoc.
import { lazyOnlyChunkNames } from "../../scripts/lazy-only-chunks.mjs";

const source = readFileSync(join(__dirname, "Base.astro"), "utf-8");
const configSource = readFileSync(join(__dirname, "../../astro.config.mjs"), "utf-8");
const publicDir = join(__dirname, "../../public");

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
// PROJ-302 replaced the original filename globs ('**/mermaid*.js' and friends) with a walk
// of the module graph, because astro 7's rolldown build names shared chunks 'chunk-<id>' and
// silently stopped matching every one of those patterns — putting 1.2 MiB of mermaid back
// into the precache. These assert the derivation, not a list of names.
describe("PWA precache — keep the install payload small (PROJ-431)", () => {
	const chunk = (fileName: string, extra = {}) => ({
		type: "chunk" as const,
		fileName,
		imports: [],
		...extra,
	});

	it("keeps everything statically reachable from an entry", () => {
		const lazy = lazyOnlyChunkNames({
			a: chunk("entry.js", { isEntry: true, imports: ["shared.js"] }),
			b: chunk("shared.js", { imports: ["deep.js"] }),
			c: chunk("deep.js"),
		});
		expect([...lazy]).toEqual([]);
	});

	it("drops a chunk only reachable through a dynamic import", () => {
		const lazy = lazyOnlyChunkNames({
			a: chunk("entry.js", { isEntry: true }),
			b: chunk("mermaid.js", { isEntry: true, isDynamicEntry: true, imports: ["dagre.js"] }),
			c: chunk("dagre.js"),
		});
		expect([...lazy].sort()).toEqual(["dagre.js", "mermaid.js"]);
	});

	// The case a name-based rule could never get right: marked is inside mermaid's dependency
	// tree, but the issue and wiki views import it eagerly.
	it("keeps a chunk shared between an eager and a lazy importer", () => {
		const lazy = lazyOnlyChunkNames({
			a: chunk("entry.js", { isEntry: true, imports: ["marked.js"] }),
			b: chunk("mermaid.js", { isEntry: true, isDynamicEntry: true, imports: ["marked.js"] }),
			c: chunk("marked.js"),
		});
		expect([...lazy]).toEqual(["mermaid.js"]);
	});

	it("does not fall over on a cycle between two chunks", () => {
		const lazy = lazyOnlyChunkNames({
			a: chunk("entry.js", { isEntry: true, imports: ["one.js"] }),
			b: chunk("one.js", { imports: ["two.js"] }),
			c: chunk("two.js", { imports: ["one.js"] }),
		});
		expect([...lazy]).toEqual([]);
	});

	it("ignores non-chunk outputs such as emitted assets", () => {
		const lazy = lazyOnlyChunkNames({
			a: chunk("entry.js", { isEntry: true }),
			b: { type: "asset" as const, fileName: "styles.css" },
		});
		expect([...lazy]).toEqual([]);
	});

	it("is wired into the service worker's precache manifest", () => {
		expect(configSource).toMatch(/manifestTransforms:/);
		expect(configSource).toMatch(/lazyOnlyChunks\.has\(/);
	});

	// The derivation above is only as good as the bundle it is handed, so the byte budget
	// asserted against the built sw.js stays the guard that actually holds. It runs as part
	// of the build (astro build && node scripts/assert-sw.mjs) because CI runs unit tests
	// before the build, so a dist-reading test here would just skip.
	it("enforces the precache budget from the build, against the built sw.js", () => {
		const pkg = JSON.parse(
			readFileSync(join(__dirname, "../../package.json"), "utf-8")
		) as { scripts: Record<string, string> };
		expect(pkg.scripts.build).toContain("scripts/assert-sw.mjs");
	});
});

// CD-293: the manifest, the service worker and HTTPS get you a Chrome install
// prompt; iOS Safari's Add to Home Screen is a separate mechanism that keys off
// the apple-* meta tags and the apple-touch-icon. The repo satisfied the first
// and none of the second.
describe("Base layout — installability (CD-293)", () => {
	it("fetches the manifest with credentials so Cloudflare Access can't swallow it", () => {
		// A default (anonymous) manifest fetch behind Access resolves to the login
		// redirect, so the browser sees no manifest and never offers to install.
		expect(source).toMatch(
			/<link\s+rel="manifest"[^>]*crossorigin="use-credentials"/
		);
	});

	it("declares itself web-app capable under both the standard and the iOS name", () => {
		expect(source).toMatch(/<meta\s+name="mobile-web-app-capable"\s+content="yes"/);
		expect(source).toMatch(/<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/);
	});

	it("names the iOS home-screen shortcut and points at a touch icon", () => {
		expect(source).toMatch(/<meta\s+name="apple-mobile-web-app-title"\s+content="Projektor"/);
		expect(source).toMatch(/<link\s+rel="apple-touch-icon"\s+href="\/icon-192\.png"/);
	});
});

describe("PWA manifest (CD-293)", () => {
	const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.json"), "utf-8")) as {
		name: string;
		short_name: string;
		start_url: string;
		display: string;
		theme_color: string;
		background_color: string;
		icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
	};

	it("has the fields Chrome requires before it will offer an install", () => {
		expect(manifest.name).toBeTruthy();
		expect(manifest.short_name).toBeTruthy();
		expect(manifest.start_url).toBe("/");
		expect(["standalone", "fullscreen", "minimal-ui"]).toContain(manifest.display);
		expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
		expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
	});

	it("ships a maskable icon so Android doesn't letterbox the launcher tile", () => {
		expect(manifest.icons.some((i) => i.purpose?.split(/\s+/).includes("maskable"))).toBe(true);
	});

	// A manifest that points at a missing or wrongly-sized icon silently suppresses
	// the install prompt, which is exactly the failure this ticket describes.
	it("references icons that exist at the declared pixel sizes", () => {
		expect(manifest.icons.length).toBeGreaterThan(0);
		for (const icon of manifest.icons) {
			const file = join(publicDir, icon.src.replace(/^\//, ""));
			const png = readFileSync(file);
			// PNG IHDR: 8-byte signature, 4-byte length, 4-byte type, then width/height.
			expect(png.subarray(12, 16).toString("ascii"), `${icon.src} is not a PNG`).toBe("IHDR");
			const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
			expect(`${w}x${h}`, `${icon.src} is not ${icon.sizes}`).toBe(icon.sizes);
		}
	});

	it("also covers the apple-touch-icon, which the manifest doesn't govern", () => {
		const href = source.match(/<link\s+rel="apple-touch-icon"\s+href="([^"]+)"/)?.[1];
		expect(href).toBeTruthy();
		expect(() => readFileSync(join(publicDir, (href as string).replace(/^\//, "")))).not.toThrow();
	});
});
