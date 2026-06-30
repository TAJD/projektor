import { describe, expect, it } from "vitest";
import {
	captureView,
	filtersMatch,
	parseSavedViews,
	removeView,
	type SavedViewFilters,
	upsertView,
	viewsStorageKey,
} from "./saved-views";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFilters(overrides: Partial<SavedViewFilters> = {}): SavedViewFilters {
	return {
		statuses: [],
		priorities: [],
		project: "",
		type: "",
		epicId: "",
		sprintId: "",
		hideEpics: false,
		dateField: "",
		dateFrom: "",
		dateTo: "",
		...overrides,
	};
}

// ─── viewsStorageKey ─────────────────────────────────────────────────────────

describe("viewsStorageKey", () => {
	it("buckets by project, falling back to 'all'", () => {
		expect(viewsStorageKey("PROJ")).toBe("issue-views-PROJ");
		expect(viewsStorageKey("")).toBe("issue-views-all");
	});
});

// ─── captureView ─────────────────────────────────────────────────────────────

describe("captureView", () => {
	it("captures the full filter set including hideEpics (PROJ-208)", () => {
		const view = captureView("My view", makeFilters({ statuses: ["s1"], hideEpics: true }));
		expect(view.name).toBe("My view");
		expect(view.filters).toEqual(makeFilters({ statuses: ["s1"], hideEpics: true }));
	});
});

// ─── parseSavedViews (defensive against legacy/malformed payloads) ────────────

describe("parseSavedViews", () => {
	it("returns [] for null, malformed JSON, or non-array payloads", () => {
		expect(parseSavedViews(null)).toEqual([]);
		expect(parseSavedViews("not json")).toEqual([]);
		expect(parseSavedViews('{"not":"an array"}')).toEqual([]);
	});

	it("drops entries with no usable name", () => {
		const raw = JSON.stringify([{ filters: {} }, { name: "", filters: {} }, 42, null]);
		expect(parseSavedViews(raw)).toEqual([]);
	});

	it("backfills missing fields on legacy views (e.g. pre-hideEpics)", () => {
		// A view saved before hideEpics existed and before some fields were added.
		const legacy = JSON.stringify([
			{ name: "old", filters: { statuses: ["s1"], project: "PROJ" } },
		]);
		const [view] = parseSavedViews(legacy);
		expect(view.filters).toEqual(makeFilters({ statuses: ["s1"], project: "PROJ" }));
		expect(view.filters.hideEpics).toBe(false);
	});

	it("ignores non-string entries inside the list-valued filters", () => {
		const raw = JSON.stringify([{ name: "v", filters: { statuses: ["ok", 5, null] } }]);
		const [view] = parseSavedViews(raw);
		expect(view.filters.statuses).toEqual(["ok"]);
	});
});

// ─── Round-trip: capture → persist → parse → identical filters ───────────────

describe("save/apply round-trip", () => {
	it("survives JSON persistence with a multi-filter combination", () => {
		const filters = makeFilters({
			statuses: ["todo", "in_progress"],
			priorities: ["high"],
			project: "PROJ",
			type: "bug",
			sprintId: "sprint-1",
			hideEpics: true,
		});
		const view = captureView("combo", filters);

		const persisted = JSON.stringify([view]);
		const [restored] = parseSavedViews(persisted);

		expect(restored.name).toBe("combo");
		expect(restored.filters).toEqual(filters);
		// The restored view is equivalent to the originally captured filters.
		expect(filtersMatch(restored.filters, filters)).toBe(true);
	});
});

// ─── filtersMatch (drives the active-view indicator) ─────────────────────────

describe("filtersMatch", () => {
	it("is order-insensitive for the list-valued filters", () => {
		const a = makeFilters({ statuses: ["a", "b"], priorities: ["high", "low"] });
		const b = makeFilters({ statuses: ["b", "a"], priorities: ["low", "high"] });
		expect(filtersMatch(a, b)).toBe(true);
	});

	it("distinguishes on the date-range filter (PROJ-212)", () => {
		expect(
			filtersMatch(
				makeFilters({ dateField: "completed", dateFrom: "2026-01-01" }),
				makeFilters({ dateField: "completed", dateFrom: "2026-02-01" })
			)
		).toBe(false);
		expect(
			filtersMatch(makeFilters({ dateField: "completed" }), makeFilters({ dateField: "updated" }))
		).toBe(false);
	});

	it("distinguishes on hideEpics", () => {
		expect(filtersMatch(makeFilters({ hideEpics: true }), makeFilters({ hideEpics: false }))).toBe(
			false
		);
	});

	it("distinguishes on a scalar filter", () => {
		expect(filtersMatch(makeFilters({ project: "A" }), makeFilters({ project: "B" }))).toBe(false);
	});
});

// ─── upsertView / removeView ─────────────────────────────────────────────────

describe("upsertView / removeView", () => {
	it("replaces a view with the same name rather than duplicating", () => {
		const v1 = captureView("v", makeFilters({ project: "A" }));
		const v2 = captureView("v", makeFilters({ project: "B" }));
		const result = upsertView([v1], v2);
		expect(result).toHaveLength(1);
		expect(result[0].filters.project).toBe("B");
	});

	it("removes a view by name", () => {
		const v1 = captureView("keep", makeFilters());
		const v2 = captureView("drop", makeFilters());
		expect(removeView([v1, v2], "drop")).toEqual([v1]);
	});
});
