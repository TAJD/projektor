import { describe, expect, it } from "vitest";
import { parseDateField } from "./useFilterUrlSync";

describe("parseDateField", () => {
	it("passes through 'completed'", () => {
		expect(parseDateField("completed")).toBe("completed");
	});

	it("passes through 'updated'", () => {
		expect(parseDateField("updated")).toBe("updated");
	});

	it("returns an empty string for null", () => {
		expect(parseDateField(null)).toBe("");
	});

	it("returns an empty string for an unrecognized value", () => {
		expect(parseDateField("created")).toBe("");
	});
});
