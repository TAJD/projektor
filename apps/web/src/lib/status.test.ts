import { describe, expect, it } from "vitest";
import { statusDisplayName } from "./status";

describe("statusDisplayName", () => {
	it("returns statusName when it is a non-empty string", () => {
		expect(statusDisplayName("In Progress", "in_progress")).toBe("In Progress");
	});

	it("falls back to statusKey when statusName is null", () => {
		expect(statusDisplayName(null, "in_progress")).toBe("in_progress");
	});

	it("falls back to statusKey when statusName is undefined", () => {
		expect(statusDisplayName(undefined, "in_progress")).toBe("in_progress");
	});

	it("falls back to em-dash when both are null", () => {
		expect(statusDisplayName(null, null)).toBe("—");
	});

	it("falls back to em-dash when both are undefined", () => {
		expect(statusDisplayName(undefined, undefined)).toBe("—");
	});

	it("falls back to em-dash when statusName is null and statusKey is undefined", () => {
		expect(statusDisplayName(null, undefined)).toBe("—");
	});

	it("returns statusName even if it is an empty string (falsy but not null/undefined)", () => {
		// ?? only skips null/undefined, not empty strings
		expect(statusDisplayName("", "in_progress")).toBe("");
	});

	it("returns statusKey even if statusName is null and statusKey is empty string", () => {
		expect(statusDisplayName(null, "")).toBe("");
	});

	it("returns whitespace statusName as-is", () => {
		expect(statusDisplayName("  ", "in_progress")).toBe("  ");
	});

	it("prefers statusName over statusKey when both are present", () => {
		expect(statusDisplayName("Todo", "todo")).toBe("Todo");
	});
});
