// Base.astro isn't a Preact component, so it can't be rendered with
// @testing-library/preact — this asserts directly on the source instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "Base.astro"), "utf-8");

describe("Base layout — mobile viewport", () => {
	it("forces 16px form-control font-size on mobile so iOS Safari doesn't auto-zoom on focus (PROJ-304)", () => {
		// PROJ-428 added a second, unrelated `@media (max-width: 640px)` block
		// (account-menu), so anchor on the iOS-zoom comment instead of the
		// (no longer unique) media-query text itself.
		const mobileQueryStart = source.indexOf("/* iOS Safari auto-zooms");
		expect(mobileQueryStart).toBeGreaterThan(-1);

		const mobileQueryEnd = source.indexOf("\n      }", mobileQueryStart);
		const mobileQuery = source.slice(mobileQueryStart, mobileQueryEnd);

		expect(mobileQuery).toMatch(/input,\s*textarea,\s*select\s*{\s*font-size:\s*16px;/);
	});
});

describe("Base layout — mobile Select menu sheet (CD-294)", () => {
	const blockStart = source.indexOf("/* CD-294: phone-sized Select menu.");
	const block = source.slice(blockStart, source.indexOf("\n      }\n", blockStart));

	it("has the mobile block, and places it after the base .select-* rules so it wins on source order", () => {
		expect(blockStart).toBeGreaterThan(-1);
		// Equal specificity (single class each), so the later rule wins — if the
		// base `.select-menu` ever moves below this block, the sheet silently dies.
		expect(blockStart).toBeGreaterThan(source.indexOf("      .select-menu {"));
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

describe("Base layout — scrollable popover menus contain their scroll (CD-294)", () => {
	it("stops .popover-select-menu chaining its scroll to the page behind it", () => {
		const start = source.indexOf("      .popover-select-menu {");
		const block = source.slice(start, source.indexOf("\n      }", start));
		expect(start).toBeGreaterThan(-1);
		expect(block).toMatch(/overflow-y:\s*auto/);
		expect(block).toMatch(/overscroll-behavior:\s*contain/);
	});
});

describe("Base layout — account menu replaces legacy login/logout emoji", () => {
	it("renders AccountMenu in the topbar and has no leftover key/door emoji links", () => {
		expect(source).toContain("<AccountMenu");
		expect(source).not.toContain("🔑");
		expect(source).not.toContain("🚪");
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
	});
});
