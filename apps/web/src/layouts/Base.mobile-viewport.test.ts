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
