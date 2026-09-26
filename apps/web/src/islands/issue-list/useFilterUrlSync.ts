import type { Dispatch, StateUpdater } from "preact/hooks";
import { useEffect } from "preact/hooks";
import { buildFilterUrlQueryString } from "../IssueList-helpers";
import type { DateField } from "./FiltersPopover";

export function parseListParam(v: string | null): string[] {
	return v ? v.split(",").filter(Boolean) : [];
}

export function parseDateField(v: string | null): DateField {
	return v === "completed" || v === "updated" ? v : "";
}

interface UrlSyncState {
	filterStatuses: string[];
	setFilterStatuses: Dispatch<StateUpdater<string[]>>;
	filterPriorities: string[];
	setFilterPriorities: Dispatch<StateUpdater<string[]>>;
	setFilterProject: Dispatch<StateUpdater<string>>;
	filterEpicId: string;
	setFilterEpicId: Dispatch<StateUpdater<string>>;
	filterSprintId: string;
	setFilterSprintId: Dispatch<StateUpdater<string>>;
	hideEpics: boolean;
	setHideEpics: Dispatch<StateUpdater<boolean>>;
	filterDateField: DateField;
	setFilterDateField: Dispatch<StateUpdater<DateField>>;
	filterDateFrom: string;
	setFilterDateFrom: Dispatch<StateUpdater<string>>;
	filterDateTo: string;
	setFilterDateTo: Dispatch<StateUpdater<string>>;
}

/** Keeps the URL in sync with filter state (PROJ-60/211/212). */
export function useFilterUrlSync(state: UrlSyncState) {
	const {
		filterStatuses,
		filterPriorities,
		filterEpicId,
		filterSprintId,
		hideEpics,
		filterDateField,
		filterDateFrom,
		filterDateTo,
	} = state;

	// PROJ-862: initial state is read from the URL synchronously (useIssueFilters'
	// lazy initialisers), not in a mount effect — the effect ran after the first
	// render, so the first issues request went out with no filters at all.

	// Sync filter state back to URL without page reload.
	useEffect(() => {
		const qs = buildFilterUrlQueryString(window.location.search, {
			filterStatuses,
			filterPriorities,
			filterEpicId,
			filterSprintId,
			hideEpics,
			filterDateField,
			filterDateFrom,
			filterDateTo,
		});
		history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
	}, [
		filterStatuses,
		filterPriorities,
		filterEpicId,
		filterSprintId,
		hideEpics,
		filterDateField,
		filterDateFrom,
		filterDateTo,
	]);
}
