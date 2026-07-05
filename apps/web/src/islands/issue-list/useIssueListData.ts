import type { ViewMode } from "./types-view";
import { useIssueFetching } from "./useIssueFetching";
import { useIssueLookups } from "./useIssueLookups";
import { useIssueMutations } from "./useIssueMutations";

interface FilterInputs {
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

/**
 * Owns all server-backed data for the issue list: the paginated issue set,
 * lookup lists (statuses/projects/task types/epics/sprints), the active
 * sprint's detail, and the mutation helpers (changeStatus/changePriority).
 */
export function useIssueListData(workspaceSlug: string | undefined, view: ViewMode, filters: FilterInputs) {
	const lookups = useIssueLookups(workspaceSlug, filters.filterProject, filters.filterSprintId);
	const fetching = useIssueFetching(workspaceSlug, view, filters, lookups.projects, lookups.taskTypes);
	const mutations = useIssueMutations(workspaceSlug, lookups.statuses, fetching.setIssues, fetching.fetchIssues);

	return { ...lookups, ...fetching, ...mutations };
}
