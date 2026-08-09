// view.astro isn't a Preact component, so it can't be rendered with
// @testing-library/preact — this asserts directly on the source instead
// (matches the pattern in layouts/Base.mobile-viewport.test.ts). It also can't
// live alongside view.astro under src/pages: Astro treats every .ts file in
// src/pages as a route module and tries to build it as one, which breaks the
// build since this file imports vitest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../pages/share/view.astro"), "utf-8");

describe("share view — wide table scroll boundary (PROJ-606)", () => {
	it("gives .prose tables their own horizontal scroll boundary", () => {
		// This page's markdown styling is hand-rolled (not Tailwind Typography), so
		// without this rule a wide table has no scroll boundary at all — unlike
		// IssueDetailParts.tsx's prose, which gets one via the same rule (PROJ-603).
		const start = source.indexOf(".prose table {");
		expect(start).toBeGreaterThan(-1);
		const block = source.slice(start, source.indexOf("}", start));
		expect(block).toMatch(/display:\s*block/);
		expect(block).toMatch(/overflow-x:\s*auto/);
	});
});
