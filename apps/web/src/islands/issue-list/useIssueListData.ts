import type { FilterQueryFilters } from "../IssueList-helpers";
import type { ViewMode } from "./types-view";
import { useIssueFetching } from "./useIssueFetching";
import { useIssueLookups } from "./useIssueLookups";
import { useIssueMutations } from "./useIssueMutations";

type FilterInputs = FilterQueryFilters;

/**
 * Owns all server-backed data for the issue list: the paginated issue set,
 * lookup lists (statuses/projects/task types/epics/sprints), the active
 * sprint's detail, and the mutation helpers (changeStatus/changePriority).
 */
export function useIssueListData(
	workspaceSlug: string | undefined,
	view: ViewMode,
	filters: FilterInputs
) {
	const lookups = useIssueLookups(workspaceSlug, filters.filterProject, filters.filterSprintId);
	// PROJ-862: the list request waits for the lookups its filters depend on, so a
	// `?project=KEY` load sends one filtered request instead of an unfiltered one first.
	const needsTaskTypes =
		filters.hideEpics || filters.filterEpicId === "none" || !!filters.filterType;
	const lookupsReady =
		(!filters.filterProject || lookups.projectsLoaded) &&
		(!needsTaskTypes || lookups.taskTypesLoaded);
	const fetching = useIssueFetching(
		workspaceSlug,
		view,
		filters,
		lookups.projects,
		lookups.taskTypes,
		lookupsReady
	);
	const mutations = useIssueMutations(
		workspaceSlug,
		lookups.statuses,
		fetching.setIssues,
		fetching.fetchIssues
	);

	return { ...lookups, ...fetching, ...mutations };
}
