import type { Issue } from "./board-utils";

export interface FilterQueryFilters {
	filterStatuses: string[];
	filterPriorities: string[];
	filterProject: string;
	filterType: string;
	filterEpicId: string;
	filterSprintId: string;
	hideEpics: boolean;
	filterDateField: "" | "completed" | "updated";
	filterDateFrom: string;
	filterDateTo: string;
}

interface KeyedById {
	key: string;
	id: string;
}

// Convert a YYYY-MM-DD date-input value to epoch seconds in local time
// (PROJ-212). `endOfDay` makes the upper bound inclusive of the whole day.
function dateInputToTs(dateStr: string, endOfDay: boolean): number {
	const [y, m, d] = dateStr.split("-").map(Number);
	const date = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
	return Math.floor(date.getTime() / 1000);
}

function applyEpicParams(
	qs: URLSearchParams,
	filterEpicId: string,
	hideEpics: boolean,
	taskTypes: readonly KeyedById[]
): void {
	if (filterEpicId && filterEpicId !== "none") qs.set("parentId", filterEpicId);
	if (filterEpicId === "none") qs.set("noParent", "true");
	// Epic exclusion runs server-side (PROJ-211): both "Hide epics" and the
	// "No epic" option drop epic-typed issues via excludeTypeIds, so the result
	// is correct across pagination rather than only on the loaded page.
	const epicTypeId = taskTypes.find((t) => t.key === "epic")?.id;
	if (epicTypeId && (hideEpics || filterEpicId === "none")) qs.set("excludeTypeIds", epicTypeId);
}

// Date-range filter (PROJ-212) runs server-side against the chosen timestamp
// column; bounds are inclusive (from = start of day, to = end).
export function applyDateRangeParams(
	qs: URLSearchParams,
	filterDateField: FilterQueryFilters["filterDateField"],
	filterDateFrom: string,
	filterDateTo: string
): void {
	if (!filterDateField || (!filterDateFrom && !filterDateTo)) return;
	const afterKey = filterDateField === "completed" ? "completedAfter" : "updatedAfter";
	const beforeKey = filterDateField === "completed" ? "completedBefore" : "updatedBefore";
	if (filterDateFrom) qs.set(afterKey, String(dateInputToTs(filterDateFrom, false)));
	if (filterDateTo) qs.set(beforeKey, String(dateInputToTs(filterDateTo, true)));
}

// Build the filter query params shared by the initial fetch and "Load more"
// (everything except limit/cursor, which the callers set).
export function buildFilterQueryParams(
	filters: FilterQueryFilters,
	projects: readonly KeyedById[],
	taskTypes: KeyedById[]
): URLSearchParams {
	const {
		filterStatuses,
		filterPriorities,
		filterProject,
		filterType,
		filterEpicId,
		filterSprintId,
		hideEpics,
		filterDateField,
		filterDateFrom,
		filterDateTo,
	} = filters;
	const qs = new URLSearchParams();
	if (filterStatuses.length) qs.set("statusIds", filterStatuses.join(","));
	if (filterPriorities.length) qs.set("priorities", filterPriorities.join(","));
	const projectId = filterProject ? projects.find((p) => p.key === filterProject)?.id : undefined;
	if (projectId) qs.set("project", projectId);
	const typeId = filterType ? taskTypes.find((t) => t.key === filterType)?.id : undefined;
	if (typeId) qs.set("typeId", typeId);
	if (filterSprintId) qs.set("sprintId", filterSprintId);
	applyEpicParams(qs, filterEpicId, hideEpics, taskTypes);
	applyDateRangeParams(qs, filterDateField, filterDateFrom, filterDateTo);
	return qs;
}

export interface UrlSyncFilters {
	filterStatuses: string[];
	filterPriorities: string[];
	filterEpicId: string;
	filterSprintId: string;
	hideEpics: boolean;
	filterDateField: "" | "completed" | "updated";
	filterDateFrom: string;
	filterDateTo: string;
}

const URL_SYNC_KEYS = [
	[
		"status",
		(f: UrlSyncFilters) => (f.filterStatuses.length > 0 ? f.filterStatuses.join(",") : null),
	],
	[
		"priority",
		(f: UrlSyncFilters) => (f.filterPriorities.length > 0 ? f.filterPriorities.join(",") : null),
	],
	// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "no filter" — `??` would keep it
	["epic", (f: UrlSyncFilters) => f.filterEpicId || null],
	// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "no filter" — `??` would keep it
	["sprintId", (f: UrlSyncFilters) => f.filterSprintId || null],
	["hideEpics", (f: UrlSyncFilters) => (f.hideEpics ? "1" : null)],
	// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "no filter" — `??` would keep it
	["dateField", (f: UrlSyncFilters) => f.filterDateField || null],
	// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "no filter" — `??` would keep it
	["dateFrom", (f: UrlSyncFilters) => f.filterDateFrom || null],
	// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "no filter" — `??` would keep it
	["dateTo", (f: UrlSyncFilters) => f.filterDateTo || null],
] as const satisfies ReadonlyArray<[string, (f: UrlSyncFilters) => string | null]>;

// Sync filter state back into the URL's query string without a page reload.
// Pure function of the current search string + filter values so the caller
// (a useEffect) reduces to a single history.replaceState call.
export function buildFilterUrlQueryString(currentSearch: string, filters: UrlSyncFilters): string {
	const params = new URLSearchParams(currentSearch);
	for (const [key, getValue] of URL_SYNC_KEYS) {
		const value = getValue(filters);
		if (value !== null) {
			params.set(key, value);
		} else {
			params.delete(key);
		}
	}
	return params.toString();
}

export interface CreateIssueInput {
	createProjectId: string;
	createTitle: string;
	createBody: string;
	createPriority: string;
	createStatusId: string;
	createTypeId: string;
}

export function buildCreateIssuePayload(input: CreateIssueInput): Record<string, unknown> {
	return {
		projectId: input.createProjectId,
		title: input.createTitle.trim(),
		// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "unset" — `??` would send "" instead of omitting
		body: input.createBody || undefined,
		priority: input.createPriority,
		// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "unset" — `??` would send "" instead of omitting
		statusId: input.createStatusId || undefined,
		// cofferdam-ignore: Refactor.PreferNullishCoalescing: "" means "unset" — `??` would send "" instead of omitting
		typeId: input.createTypeId || undefined,
	};
}

interface ProjectLookup {
	id: string;
	key: string;
	name: string;
}

interface StatusLookup {
	id: string;
	key: string;
	name: string;
	category: string;
}

interface TaskTypeLookup {
	id: string;
	key: string;
	name: string;
}

export function buildOptimisticIssue(
	created: Readonly<{ id: string; number: number }>,
	input: CreateIssueInput,
	lookups: Readonly<{ projects: ProjectLookup[]; statuses: StatusLookup[]; taskTypes: TaskTypeLookup[] }>
): Issue {
	const proj = lookups.projects.find((p) => p.id === input.createProjectId);
	const chosenStatus = lookups.statuses.find((s) => s.id === input.createStatusId);
	const chosenType = lookups.taskTypes.find((t) => t.id === input.createTypeId);
	const now = Math.floor(Date.now() / 1000);
	return {
		id: created.id,
		number: created.number,
		title: input.createTitle.trim(),
		priority: input.createPriority,
		assignee_id: null,
		assignee_name: null,
		parent_id: null,
		project_id: input.createProjectId,
		project_key: proj?.key ?? null,
		project_name: proj?.name ?? null,
		type_key: chosenType?.key ?? null,
		type_name: chosenType?.name ?? null,
		status_id: chosenStatus?.id ?? null,
		status_key: chosenStatus?.key ?? "backlog",
		status_name: chosenStatus?.name ?? "Backlog",
		status_category: chosenStatus?.category ?? "todo",
		sprint_id: null,
		updated_at: now,
		created_at: now,
		customFields: [],
	};
}
