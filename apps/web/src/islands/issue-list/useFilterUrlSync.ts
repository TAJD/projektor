import type { Dispatch, StateUpdater } from "preact/hooks";
import { useEffect } from "preact/hooks";
import { buildFilterUrlQueryString } from "../IssueList-helpers";
import type { DateField } from "./FiltersPopover";

function parseListParam(v: string | null): string[] {
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

/** Reads filters from the URL on mount, then keeps the URL in sync with filter state (PROJ-60/211/212). */
export function useFilterUrlSync(state: UrlSyncState) {
	const {
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		setFilterProject,
		filterEpicId,
		setFilterEpicId,
		filterSprintId,
		setFilterSprintId,
		hideEpics,
		setHideEpics,
		filterDateField,
		setFilterDateField,
		filterDateFrom,
		setFilterDateFrom,
		filterDateTo,
		setFilterDateTo,
	} = state;

	// Read initial filter state from URL params on mount.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setFilterStatuses(parseListParam(params.get("status")));
		setFilterPriorities(parseListParam(params.get("priority")));
		setFilterProject(params.get("project") ?? "");
		setFilterEpicId(params.get("epic") ?? "");
		setFilterSprintId(params.get("sprintId") ?? "");
		setHideEpics(params.get("hideEpics") === "1");
		setFilterDateField(parseDateField(params.get("dateField")));
		setFilterDateFrom(params.get("dateFrom") ?? "");
		setFilterDateTo(params.get("dateTo") ?? "");
	}, []);

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
