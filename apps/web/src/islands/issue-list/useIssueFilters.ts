import { useState } from "preact/hooks";
import type { SortKey } from "../board-utils";
import type { SavedViewFilters } from "../saved-views";
import type { DateField } from "./FiltersPopover";
import { parseDateField, useFilterUrlSync } from "./useFilterUrlSync";

/** Owns all issue-list filter/sort state, plus URL <-> state sync (PROJ-60/211/212). */
export function useIssueFilters() {
	const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
	const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
	const [filterProject, setFilterProject] = useState("");
	const [filterType, setFilterType] = useState("");
	const [filterEpicId, setFilterEpicId] = useState("");
	const [hideEpics, setHideEpics] = useState(false);
	const [filterDateField, setFilterDateField] = useState<DateField>("");
	const [filterDateFrom, setFilterDateFrom] = useState("");
	const [filterDateTo, setFilterDateTo] = useState("");
	const [filterSprintId, setFilterSprintId] = useState("");
	const [sortBy, setSortBy] = useState<SortKey>("created_at");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	useFilterUrlSync({
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
	});

	function handleHeaderClick(key: SortKey) {
		if (sortBy === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortBy(key);
			setSortDir("asc");
		}
	}

	const filtersBundle: SavedViewFilters = {
		statuses: filterStatuses,
		priorities: filterPriorities,
		project: filterProject,
		type: filterType,
		epicId: filterEpicId,
		sprintId: filterSprintId,
		hideEpics,
		dateField: filterDateField,
		dateFrom: filterDateFrom,
		dateTo: filterDateTo,
	};

	function applyFilters(filters: SavedViewFilters) {
		setFilterStatuses(filters.statuses);
		setFilterPriorities(filters.priorities);
		setFilterProject(filters.project);
		setFilterType(filters.type);
		setFilterEpicId(filters.epicId);
		setFilterSprintId(filters.sprintId);
		setHideEpics(filters.hideEpics);
		setFilterDateField(parseDateField(filters.dateField));
		setFilterDateFrom(filters.dateFrom);
		setFilterDateTo(filters.dateTo);
	}

	return {
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		filterProject,
		setFilterProject,
		filterType,
		setFilterType,
		filterEpicId,
		setFilterEpicId,
		hideEpics,
		setHideEpics,
		filterDateField,
		setFilterDateField,
		filterDateFrom,
		setFilterDateFrom,
		filterDateTo,
		setFilterDateTo,
		filterSprintId,
		setFilterSprintId,
		sortBy,
		setSortBy,
		sortDir,
		setSortDir,
		handleHeaderClick,
		filtersBundle,
		applyFilters,
	};
}
