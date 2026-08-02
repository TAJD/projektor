import { describe, expect, it } from "vitest";
import { applyDateRangeParams } from "./IssueList-helpers";

function startOfDayTs(dateStr: string): number {
	const [y, m, d] = dateStr.split("-").map(Number);
	return Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000);
}

function endOfDayTs(dateStr: string): number {
	const [y, m, d] = dateStr.split("-").map(Number);
	return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000);
}

describe("applyDateRangeParams (PROJ-212)", () => {
	it("does nothing when no date field is selected", () => {
		const qs = new URLSearchParams();
		applyDateRangeParams(qs, "", "2026-01-01", "2026-01-31");
		expect([...qs.keys()]).toEqual([]);
	});

	it("does nothing when a date field is selected but no bounds are given", () => {
		const qs = new URLSearchParams();
		applyDateRangeParams(qs, "updated", "", "");
		expect([...qs.keys()]).toEqual([]);
	});

	it("sets updatedAfter/updatedBefore for the 'updated' field", () => {
		const qs = new URLSearchParams();
		applyDateRangeParams(qs, "updated", "2026-01-01", "2026-01-31");
		expect(qs.get("updatedAfter")).toBe(String(startOfDayTs("2026-01-01")));
		expect(qs.get("updatedBefore")).toBe(String(endOfDayTs("2026-01-31")));
	});

	it("sets completedAfter/completedBefore for the 'completed' field", () => {
		const qs = new URLSearchParams();
		applyDateRangeParams(qs, "completed", "2026-01-01", "2026-01-31");
		expect(qs.get("completedAfter")).toBe(String(startOfDayTs("2026-01-01")));
		expect(qs.get("completedBefore")).toBe(String(endOfDayTs("2026-01-31")));
	});

	it("only sets the 'after' bound when only a from-date is given", () => {
		const qs = new URLSearchParams();
		applyDateRangeParams(qs, "updated", "2026-01-01", "");
		expect(qs.get("updatedAfter")).toBe(String(startOfDayTs("2026-01-01")));
		expect(qs.has("updatedBefore")).toBe(false);
	});
});
