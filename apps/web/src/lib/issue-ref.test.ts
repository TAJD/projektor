import { describe, expect, it } from "vitest";
import { formatIssueRef, isValidIssueRef, normalizeIssueRef } from "./issue-ref";

// ─── formatIssueRef ───────────────────────────────────────────────────────────

describe("formatIssueRef", () => {
	it("returns KEY-NUMBER when project key is provided", () => {
		expect(formatIssueRef("PROJ", 42)).toBe("PROJ-42");
	});

	it("returns the number as a string when project key is null", () => {
		expect(formatIssueRef(null, 7)).toBe("7");
	});

	it("returns the number as a string when project key is undefined", () => {
		expect(formatIssueRef(undefined, 1)).toBe("1");
	});

	it("returns the number as a string when project key is empty string", () => {
		// empty string is falsy — treated like null
		expect(formatIssueRef("", 5)).toBe("5");
	});

	it("handles issue number 0", () => {
		expect(formatIssueRef("PROJ", 0)).toBe("PROJ-0");
	});

	it("handles large issue numbers", () => {
		expect(formatIssueRef("ALPHA", 9999)).toBe("ALPHA-9999");
	});

	it("works with multi-segment project keys", () => {
		expect(formatIssueRef("MY-PROJ", 3)).toBe("MY-PROJ-3");
	});
});

// ─── normalizeIssueRef ────────────────────────────────────────────────────────

describe("normalizeIssueRef", () => {
	it("uppercases the input", () => {
		expect(normalizeIssueRef("proj-42")).toBe("PROJ-42");
	});

	it("trims leading and trailing whitespace", () => {
		expect(normalizeIssueRef("  PROJ-42  ")).toBe("PROJ-42");
	});

	it("trims and uppercases together", () => {
		expect(normalizeIssueRef("  proj-1  ")).toBe("PROJ-1");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(normalizeIssueRef("   ")).toBe("");
	});

	it("returns empty string for empty input", () => {
		expect(normalizeIssueRef("")).toBe("");
	});

	it("does not alter an already-normalized ref", () => {
		expect(normalizeIssueRef("PROJ-42")).toBe("PROJ-42");
	});
});

// ─── isValidIssueRef ─────────────────────────────────────────────────────────

describe("isValidIssueRef", () => {
	it("returns true for a canonical KEY-NUMBER ref", () => {
		expect(isValidIssueRef("PROJ-42")).toBe(true);
	});

	it("returns true for a single-letter key", () => {
		expect(isValidIssueRef("A-1")).toBe(true);
	});

	it("returns true for a key with multiple uppercase letters", () => {
		expect(isValidIssueRef("ALPHA-100")).toBe(true);
	});

	it("returns true for issue number 0", () => {
		expect(isValidIssueRef("PROJ-0")).toBe(true);
	});

	it("returns false for a lowercase key", () => {
		expect(isValidIssueRef("proj-42")).toBe(false);
	});

	it("returns false for mixed-case key", () => {
		expect(isValidIssueRef("Proj-42")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isValidIssueRef("")).toBe(false);
	});

	it("returns false for a number-only string", () => {
		expect(isValidIssueRef("42")).toBe(false);
	});

	it("returns false for a key with no number", () => {
		expect(isValidIssueRef("PROJ-")).toBe(false);
	});

	it("returns false for a key with a non-integer number part", () => {
		expect(isValidIssueRef("PROJ-4.2")).toBe(false);
	});

	it("returns false when the number part contains letters", () => {
		expect(isValidIssueRef("PROJ-42X")).toBe(false);
	});

	it("returns false for input with surrounding whitespace", () => {
		// Validation expects pre-normalized input
		expect(isValidIssueRef(" PROJ-42 ")).toBe(false);
	});

	it("returns false for input with no hyphen", () => {
		expect(isValidIssueRef("PROJ42")).toBe(false);
	});

	it("returns true for a key containing digits (PROJ-440)", () => {
		expect(isValidIssueRef("WEB2-15")).toBe(true);
	});

	it("returns false for a key starting with a digit", () => {
		expect(isValidIssueRef("2FA-1")).toBe(false);
	});
});
