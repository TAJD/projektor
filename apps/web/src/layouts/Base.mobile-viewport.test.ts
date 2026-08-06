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
		expect(source).toMatch(/var HIDE_THRESHOLD = 40;/);
		expect(source).toMatch(/var REVEAL_THRESHOLD = 24;/);
	});

	it("accumulates upward scroll before revealing instead of un-hiding on any negative delta", () => {
		const scriptStart = source.indexOf("var HIDE_THRESHOLD");
		const scriptEnd = source.indexOf("</script>", scriptStart);
		const script = source.slice(scriptStart, scriptEnd);
		expect(script).toMatch(/accumulatedUp \+= -delta;/);
		expect(script).toMatch(/if \(accumulatedUp > REVEAL_THRESHOLD\) topbar\.classList\.remove\('topbar-hidden'\);/);
	});
});
