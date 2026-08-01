import { describe, expect, it } from "vitest";
import { safeDecodeURIComponent, wikiPagePath } from "../lib/urls";

// PROJ-512 finding 6: the server-side branch that calls safeDecodeURIComponent
// (index.ts's SSR fallback) is unreachable in this test env — ASSETS is absent, so
// `if (!c.env.ASSETS) return c.notFound()` fires before it (see health.test.ts).
// Test the pure function directly against a spread of malformed percent-escapes.
describe("safeDecodeURIComponent", () => {
	it("decodes a well-formed percent-escape", () => {
		expect(safeDecodeURIComponent("100%25")).toBe("100%");
	});

	it("returns null for a bare '%' with no following hex digits", () => {
		expect(safeDecodeURIComponent("100%")).toBeNull();
	});

	it("returns null for a truncated escape ('%2' missing its second hex digit)", () => {
		expect(safeDecodeURIComponent("a%2")).toBeNull();
	});

	it("returns null for a non-hex escape ('%zz')", () => {
		expect(safeDecodeURIComponent("a%zz")).toBeNull();
	});

	it("returns null for a truncated multibyte sequence ('%E0%A4%A')", () => {
		expect(safeDecodeURIComponent("%E0%A4%A")).toBeNull();
	});

	it("passes through a string with no percent-escapes unchanged", () => {
		expect(safeDecodeURIComponent("plain-slug")).toBe("plain-slug");
	});
});

describe("wikiPagePath", () => {
	it("percent-encodes the slug into the path", () => {
		expect(wikiPagePath("my-page")).toBe("/wiki/my-page");
	});
});
