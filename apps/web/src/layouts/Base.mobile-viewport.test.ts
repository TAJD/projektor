// Base.astro isn't a Preact component, so it can't be rendered with
// @testing-library/preact — this asserts directly on the source instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "Base.astro"), "utf-8");
const shellCss = readFileSync(join(__dirname, "../styles/shell.css"), "utf-8");
const componentsCss = readFileSync(join(__dirname, "../styles/components.css"), "utf-8");

describe("Base layout — mobile viewport", () => {
	it("forces 16px form-control font-size on mobile so iOS Safari doesn't auto-zoom on focus (PROJ-304)", () => {
		// PROJ-428 added a second, unrelated `@media (max-width: 640px)` block
		// (account-menu), so anchor on the iOS-zoom comment instead of the
		// (no longer unique) media-query text itself.
		const mobileQueryStart = shellCss.indexOf("/* iOS Safari auto-zooms");
		expect(mobileQueryStart).toBeGreaterThan(-1);

		const mobileQueryEnd = shellCss.indexOf("\n\t}", mobileQueryStart);
		const mobileQuery = shellCss.slice(mobileQueryStart, mobileQueryEnd);

		expect(mobileQuery).toMatch(/input,\s*textarea,\s*select\s*{\s*font-size:\s*16px;/);
	});
});

describe("Base layout — mobile Select menu sheet (CD-294)", () => {
	const blockStart = componentsCss.indexOf("/* CD-294: phone-sized Select menu.");
	const block = componentsCss.slice(blockStart, componentsCss.indexOf("\n}\n", blockStart));

	it("has the mobile block, and places it after the base .select-* rules so it wins on source order", () => {
		expect(blockStart).toBeGreaterThan(-1);
		// Equal specificity (single class each), so the later rule wins — if the
		// base `.select-menu` ever moves below this block, the sheet silently dies.
		expect(blockStart).toBeGreaterThan(componentsCss.indexOf(".select-menu {"));
	});

	it("anchors the menu to the bottom of the viewport instead of under its trigger", () => {
		expect(block).toMatch(/position:\s*fixed/);
		expect(block).toMatch(/top:\s*auto/);
		expect(block).toMatch(/bottom:\s*0/);
	});

	it("uses dvh (not vh) and contains its own scroll so it can't chain to the page", () => {
		expect(block).toMatch(/max-height:\s*50dvh/);
		expect(block).toMatch(/overscroll-behavior:\s*contain/);
	});

	it("pads for the iOS home-indicator safe area", () => {
		expect(block).toMatch(/padding-bottom:\s*max\(0\.25rem,\s*env\(safe-area-inset-bottom\)\)/);
	});

	it("gives options and triggers a 44px minimum touch target", () => {
		expect(block).toMatch(/\.select-option\s*{\s*min-height:\s*44px;/);
		expect(block).toMatch(/\.select-button\s*{\s*min-height:\s*44px;/);
	});
});

describe("Base layout — account menu replaces legacy login/logout emoji", () => {
	it("renders AccountMenu in the topbar and has no leftover key/door emoji links", () => {
		expect(source).toContain("<AccountMenu");
		expect(source).not.toContain("🔑");
		expect(source).not.toContain("🚪");
	});
});

describe("Base layout — icon consistency and tri-state theme control (PROJ-758)", () => {
	it("has no leftover emoji or bare glyph controls in the sidebar footer", () => {
		expect(source).not.toContain("🌙");
		expect(source).not.toContain("☀️");
		expect(source).not.toContain('title="Help">?<');
	});

	it("keys nav icons off an explicit icon field, not the label text", () => {
		expect(source).not.toMatch(/item\.label === 'Tokens'/);
		expect(source).toMatch(/icon:\s*'tokens'/);
		expect(source).toMatch(/item\.icon === 'tokens'/);
	});

	it("cycles the theme control across system, light and dark", () => {
		const scriptStart = source.indexOf("var ORDER = ['system', 'light', 'dark'];");
		expect(scriptStart).toBeGreaterThan(-1);
		const scriptEnd = source.indexOf("</script>", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(script).toMatch(/ORDER\[\(ORDER\.indexOf\(getCurrentState\(\)\) \+ 1\) % ORDER\.length\]/);
	});

	it("derives the current theme state from the DOM, not localStorage, so a blocked/throwing localStorage can't stick the toggle on one state", () => {
		const scriptStart = source.indexOf("var ORDER = ['system', 'light', 'dark'];");
		const scriptEnd = source.indexOf("})();", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(script).toMatch(/function getCurrentState\(\)/);
		expect(script).toMatch(/var t = document\.documentElement\.getAttribute\('data-theme'\);/);

		document.body.innerHTML = '<button class="theme-toggle"><svg></svg></button>';
		const originalLocalStorage = window.localStorage;
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			get() {
				throw new Error("blocked");
			},
		});
		try {
			new Function(script)();
			document.dispatchEvent(new Event("astro:page-load"));
			const themeBtn = document.querySelector("button.theme-toggle") as HTMLButtonElement;
			const seen: (string | null)[] = [document.documentElement.getAttribute("data-theme")];
			for (let i = 0; i < 3; i++) {
				themeBtn.click();
				seen.push(document.documentElement.getAttribute("data-theme"));
			}
			expect(seen).toEqual([null, "light", "dark", null]);
		} finally {
			Object.defineProperty(window, "localStorage", {
				configurable: true,
				value: originalLocalStorage,
			});
			document.documentElement.removeAttribute("data-theme");
		}
	});

	it("writes the chosen theme into the shared prefs object and clears the legacy standalone key", () => {
		const scriptStart = source.indexOf("var ORDER = ['system', 'light', 'dark'];");
		const scriptEnd = source.indexOf("</script>", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(script).toMatch(/p\.theme = next;/);
		expect(script).toMatch(/localStorage\.setItem\('prefs', JSON\.stringify\(p\)\);/);
		expect(script).toMatch(/localStorage\.removeItem\('theme'\);/);
		expect(script).toMatch(/if \(next === 'system'\) document\.documentElement\.removeAttribute\('data-theme'\);/);
	});
});

describe("Base layout — preferences bootstrap and sidebar collapse (PROJ-760)", () => {
	beforeEach(() => {
		document.documentElement.removeAttribute("data-theme");
		document.documentElement.removeAttribute("data-density");
		document.documentElement.removeAttribute("data-sidebar");
	});

	function bootstrapScript() {
		const scriptStart = source.indexOf("function readPrefs() {");
		const scriptEnd = source.indexOf("})();", scriptStart);
		return source.slice(scriptStart, scriptEnd);
	}

	it("applies stored density and sidebar prefs to the document on load", () => {
		localStorage.setItem("prefs", JSON.stringify({ theme: "system", density: "compact", sidebar: "collapsed" }));
		try {
			new Function(bootstrapScript())();
			expect(document.documentElement.getAttribute("data-density")).toBe("compact");
			expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
		} finally {
			localStorage.removeItem("prefs");
		}
	});

	it("migrates a legacy standalone theme key into the prefs bootstrap when no prefs object exists", () => {
		localStorage.setItem("theme", "dark");
		try {
			new Function(bootstrapScript())();
			expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
			expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
			expect(document.documentElement.getAttribute("data-sidebar")).toBe("expanded");
		} finally {
			localStorage.removeItem("theme");
		}
	});

	it("re-applies prefs on astro:after-swap so a client-side nav doesn't revert to the server-rendered defaults", () => {
		expect(bootstrapScript()).toMatch(/document\.addEventListener\('astro:after-swap', applyPrefs\);/);
	});

	it("cycles the sidebar collapse toggle and persists the choice without clobbering theme/density", () => {
		localStorage.setItem("prefs", JSON.stringify({ theme: "dark", density: "compact", sidebar: "expanded" }));
		document.body.innerHTML = '<button class="sidebar-collapse-toggle"></button>';
		const scriptStart = source.indexOf("function isCollapsed() {");
		const scriptEnd = source.indexOf("})();", scriptStart);
		const script = source
			.slice(scriptStart, scriptEnd)
			.replace(
				"document.addEventListener('astro:page-load', bindSidebarCollapseToggle);",
				"bindSidebarCollapseToggle();"
			);
		try {
			new Function(script)();
			const btn = document.querySelector(".sidebar-collapse-toggle") as HTMLButtonElement;
			btn.click();
			expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
			const stored = JSON.parse(localStorage.getItem("prefs") ?? "{}");
			expect(stored).toEqual({ theme: "dark", density: "compact", sidebar: "collapsed" });
		} finally {
			localStorage.removeItem("prefs");
		}
	});

	it("derives theme from the DOM when toggling collapse with no prefs object stored yet", () => {
		document.documentElement.setAttribute("data-theme", "light");
		document.body.innerHTML = '<button class="sidebar-collapse-toggle"></button>';
		const scriptStart = source.indexOf("function isCollapsed() {");
		const scriptEnd = source.indexOf("})();", scriptStart);
		const script = source
			.slice(scriptStart, scriptEnd)
			.replace(
				"document.addEventListener('astro:page-load', bindSidebarCollapseToggle);",
				"bindSidebarCollapseToggle();"
			);
		try {
			new Function(script)();
			const btn = document.querySelector(".sidebar-collapse-toggle") as HTMLButtonElement;
			btn.click();
			const stored = JSON.parse(localStorage.getItem("prefs") ?? "{}");
			expect(stored).toEqual({ theme: "light", density: "comfortable", sidebar: "collapsed" });
		} finally {
			localStorage.removeItem("prefs");
			document.documentElement.removeAttribute("data-theme");
		}
	});
});

describe("Base layout — topbar hide-on-scroll thresholds (PROJ-569)", () => {
	it("requires a deliberate scroll in each direction before toggling, not a single pixel", () => {
		// PROJ-569: an 8px hide threshold with an un-thresholded reveal flickered the
		// topbar on mobile touch-scroll jitter. Both directions need real headroom now.
		expect(source).toMatch(/HIDE_THRESHOLD\s*=\s*40/);
		expect(source).toMatch(/REVEAL_THRESHOLD\s*=\s*24/);
	});

	it("accumulates upward scroll before revealing instead of un-hiding on any negative delta", () => {
		const scriptStart = source.indexOf("var HIDE_THRESHOLD");
		const scriptEnd = source.indexOf("</script>", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(script).toMatch(/accumulatedUp \+= -delta;/);
		expect(script).toMatch(/if \(accumulatedUp > REVEAL_THRESHOLD\) topbar\.classList\.remove\('topbar-hidden'\);/);
	});

	it("initializes lastY from the real scroll position, and resets it on first load too (PROJ-572)", () => {
		// A page loading already scrolled (bfcache restore, scroll restoration, #anchor
		// link) must not compute its first delta against a stale lastY = 0 — that slams
		// the topbar hidden immediately instead of respecting the 40px threshold.
		const scriptStart = source.indexOf("var lastY");
		const scriptEnd = source.indexOf("</script>", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(script).toMatch(/var lastY = window\.scrollY;/);
		// astro:after-swap alone misses the very first load (it only fires on
		// client-side navigations), so the reset must also run on astro:page-load.
		expect(script).toMatch(/addEventListener\('astro:after-swap', resetTopbarScrollState\)/);
		expect(script).toMatch(/addEventListener\('astro:page-load', resetTopbarScrollState\)/);
	});

	it("guards against re-binding its listeners on every client-side nav (PROJ-595)", () => {
		// This inline script isn't dedup'd across Astro swaps — without a guard,
		// every nav adds another scroll/astro:* listener on top of the previous set.
		const scriptStart = source.indexOf("if (window.__topbarScrollBound)");
		const scriptEnd = source.indexOf("</script>", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(scriptStart).toBeGreaterThan(-1);
		expect(script).toMatch(/if \(window\.__topbarScrollBound\) return;/);
		expect(script).toMatch(/window\.__topbarScrollBound = true;/);
	});

	it("treats the scroll after an in-page #anchor click as a reset, not a hide trigger (PROJ-594)", () => {
		// An anchor jump has no Astro navigation event to reset tracking state
		// against, so it reads as one huge delta and slams the topbar hidden
		// regardless of the hide threshold.
		const scriptStart = source.indexOf("var lastY");
		const scriptEnd = source.indexOf("</script>", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(script).toMatch(/e\.target\.closest\('a\[href\^="#"\]'\)/);
		expect(script).toMatch(/expectingAnchorJump = true;/);
		expect(script).toMatch(/if \(expectingAnchorJump\) {\s*expectingAnchorJump = false;\s*resetTopbarScrollState\(\);/);
		// The flag above is only ever set inside onClick — without actually binding
		// it, the detection logic would be dead code that never runs.
		expect(script).toMatch(/document\.addEventListener\('click', onClick\);/);
	});
});
