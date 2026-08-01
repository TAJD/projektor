import { describe, expect, it } from "vitest";
import { safeDecodeURIComponent } from "./urls";

describe("safeDecodeURIComponent", () => {
	it("decodes a well-formed percent-escape", () => {
		expect(safeDecodeURIComponent("100%25")).toBe("100%");
	});

	it("returns an empty string for a bare '%' with no following hex digits", () => {
		expect(safeDecodeURIComponent("100%")).toBe("");
	});

	it("returns an empty string for a non-hex escape ('%zz')", () => {
		expect(safeDecodeURIComponent("a%zz")).toBe("");
	});

	it("passes through a string with no percent-escapes unchanged", () => {
		expect(safeDecodeURIComponent("plain-slug")).toBe("plain-slug");
	});
});
