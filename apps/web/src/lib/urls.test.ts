import { describe, expect, it } from "vitest";
import { safeDecodeURIComponent } from "./urls";

describe("safeDecodeURIComponent", () => {
	it("decodes a well-formed percent-escape", () => {
		expect(safeDecodeURIComponent("100%25")).toBe("100%");
	});

	it("returns null for a bare '%' with no following hex digits", () => {
		expect(safeDecodeURIComponent("100%")).toBeNull();
	});

	it("returns null for a non-hex escape ('%zz')", () => {
		expect(safeDecodeURIComponent("a%zz")).toBeNull();
	});

	it("passes through a string with no percent-escapes unchanged", () => {
		expect(safeDecodeURIComponent("plain-slug")).toBe("plain-slug");
	});
});
