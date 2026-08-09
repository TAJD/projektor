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
	it("keeps tables full-width and gives the .table-scroll wrapper the scroll boundary (PROJ-605)", () => {
		// This page's markdown styling is hand-rolled (not Tailwind Typography), so
		// without these rules a wide table has no scroll boundary at all — unlike
		// IssueDetailParts.tsx's prose, which gets one via the same rules (PROJ-603).
		// renderMd's table renderer (markdown.ts) wraps every rendered <table> in a
		// .table-scroll div, so the boundary lives on the wrapper, not the table
		// itself — a bare "display: block" on <table> would shrink a narrow table
		// to content width instead of spanning the container (PROJ-605).
		const tableStart = source.indexOf(".prose table {");
		expect(tableStart).toBeGreaterThan(-1);
		const tableBlock = source.slice(tableStart, source.indexOf("}", tableStart));
		expect(tableBlock).toMatch(/width:\s*100%/);

		const scrollStart = source.indexOf(".prose .table-scroll {");
		expect(scrollStart).toBeGreaterThan(-1);
		const scrollBlock = source.slice(scrollStart, source.indexOf("}", scrollStart));
		expect(scrollBlock).toMatch(/overflow-x:\s*auto/);
	});
});
