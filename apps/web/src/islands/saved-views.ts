// Saved views (PROJ-141, hardened in PROJ-208).
//
// A saved view is a named combination of issue-list filters, persisted in
// localStorage. These are cosmetic filter preferences (no API/entity refs), so
// per AGENTS.md they belong in localStorage rather than a backend table.
//
// This module is the pure, testable core: capture the current filters into a
// view, normalise/parse stored payloads defensively (older views may be missing
// fields), apply a view back to filter state, and compare filters for the
// "active view" indicator. The IssueList island wires these to component state.

export interface SavedViewFilters {
	statuses: string[];
	priorities: string[];
	/** Project key (not UUID) — matches the island's filterProject state. */
	project: string;
	/** Task type key (not UUID) — matches the island's filterType state. */
	type: string;
	epicId: string;
	sprintId: string;
	hideEpics: boolean;
	/** Date-range filter field: "" (off), "completed", or "updated" (PROJ-212). */
	dateField: string;
	/** Inclusive range bounds as YYYY-MM-DD date-input strings ("" when unset). */
	dateFrom: string;
	dateTo: string;
}

export interface SavedView {
	name: string;
	filters: SavedViewFilters;
}

export function viewsStorageKey(project: string): string {
	return `issue-views-${project || "all"}`;
}

/**
 * Coerce an arbitrary (possibly legacy or partial) filters object into a
 * complete SavedViewFilters. Missing fields fall back to the empty default, so
 * a view saved before a new filter existed (e.g. hideEpics) still applies
 * cleanly instead of writing `undefined` into filter state.
 */
function normalizeFilters(raw: Partial<SavedViewFilters> | null | undefined): SavedViewFilters {
	const r = (raw ?? {}) as Partial<SavedViewFilters>;
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	return {
		statuses: strings(r.statuses),
		priorities: strings(r.priorities),
		project: str(r.project),
		type: str(r.type),
		epicId: str(r.epicId),
		sprintId: str(r.sprintId),
		hideEpics: r.hideEpics === true,
		dateField: str(r.dateField),
		dateFrom: str(r.dateFrom),
		dateTo: str(r.dateTo),
	};
}

export function captureView(name: string, filters: SavedViewFilters): SavedView {
	return { name, filters: normalizeFilters(filters) };
}

/** Parse the localStorage payload, dropping anything malformed or unnamed. */
export function parseSavedViews(raw: string | null): SavedView[] {
	if (!raw) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const out: SavedView[] = [];
	for (const v of data) {
		if (typeof v !== "object" || v === null) continue;
		const name = (v as { name?: unknown }).name;
		if (typeof name !== "string" || name.length === 0) continue;
		out.push({
			name,
			filters: normalizeFilters((v as { filters?: Partial<SavedViewFilters> }).filters),
		});
	}
	return out;
}

/** Insert or replace a view by name (names are unique within a bucket). */
export function upsertView(views: readonly SavedView[], view: SavedView): SavedView[] {
	return [...views.filter((v) => v.name !== view.name), view];
}

export function removeView(views: readonly SavedView[], name: string): SavedView[] {
	return views.filter((v) => v.name !== name);
}

/** Order-insensitive equality for the two list-valued filters. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** True when two filter sets are equivalent (drives the active-view indicator). */
export function filtersMatch(a: SavedViewFilters, b: SavedViewFilters): boolean {
	return (
		sameSet(a.statuses, b.statuses) &&
		sameSet(a.priorities, b.priorities) &&
		a.project === b.project &&
		a.type === b.type &&
		a.epicId === b.epicId &&
		a.sprintId === b.sprintId &&
		a.hideEpics === b.hideEpics &&
		a.dateField === b.dateField &&
		a.dateFrom === b.dateFrom &&
		a.dateTo === b.dateTo
	);
}
