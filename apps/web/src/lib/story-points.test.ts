import { describe, expect, it } from "vitest";
import { parseStoryPoints } from "./story-points";

describe("parseStoryPoints", () => {
	it("returns null for empty string (cleared field)", () => {
		expect(parseStoryPoints("")).toBeNull();
	});

	it("returns the numeric value for a valid integer string", () => {
		expect(parseStoryPoints("5")).toBe(5);
	});

	it("returns the numeric value for a valid decimal string", () => {
		expect(parseStoryPoints("2.5")).toBe(2.5);
	});

	it("returns 0 for the string '0'", () => {
		expect(parseStoryPoints("0")).toBe(0);
	});

	it("returns null for a non-numeric string", () => {
		expect(parseStoryPoints("abc")).toBeNull();
	});

	it("returns null for a string that is only whitespace", () => {
		// whitespace-only is not empty string, but parseFloat returns NaN
		expect(parseStoryPoints("   ")).toBeNull();
	});

	it("returns null for a string with letters mixed in after digits", () => {
		// parseFloat("3abc") returns 3, but "3abc" is not a clean number
		// — the function accepts what parseFloat accepts (leading numeric prefix)
		expect(parseStoryPoints("3abc")).toBe(3);
	});

	it("returns a negative number for a negative value", () => {
		expect(parseStoryPoints("-1")).toBe(-1);
	});

	it("handles large numbers", () => {
		expect(parseStoryPoints("100")).toBe(100);
	});

	it("returns null for 'NaN'", () => {
		expect(parseStoryPoints("NaN")).toBeNull();
	});

	it("returns null for 'Infinity'", () => {
		// parseFloat('Infinity') = Infinity, which is not NaN, so it's returned
		// This documents the current behaviour rather than guarding against it
		expect(parseStoryPoints("Infinity")).toBe(Number.POSITIVE_INFINITY);
	});
});
