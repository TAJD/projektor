import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../../utils/api-client";
import type { Issue } from "../board-utils";
import { buildFilterQueryParams } from "../IssueList-helpers";
import type { ProjectMeta } from "./types";
import type { ViewMode } from "./types-view";

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

/** Owns the paginated issue set: fetching, "Load more", and loading/error state (PROJ-201/211). */
export function useIssueFetching(
	workspaceSlug: string | undefined,
	view: ViewMode,
	filters: FilterInputs,
	projects: ProjectMeta[],
	taskTypes: Array<{ id: string; key: string; name: string }>
) {
	const [issues, setIssues] = useState<Issue[]>([]);
	const [loading, setLoading] = useState(true);
	const hasLoadedOnce = useRef(false);
	// Guards against out-of-order responses when filters change rapidly: only the
	// response from the most recently issued fetchIssues call is applied.
	const fetchSeq = useRef(0);
	const [error, setError] = useState<string | null>(null);
	// Pagination (PROJ-201): list view loads 30 at a time and appends via "Load more".
	const [nextCursor, setNextCursor] = useState<number | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);

	// Build the filter query params shared by the initial fetch and "Load more"
	// (everything except limit/cursor, which the callers set).
	const buildFilterParams = useCallback(
		() => buildFilterQueryParams(filters, projects, taskTypes),
		[
			filters.filterStatuses,
			filters.filterPriorities,
			filters.filterProject,
			filters.filterType,
			filters.filterEpicId,
			filters.filterSprintId,
			filters.hideEpics,
			filters.filterDateField,
			filters.filterDateFrom,
			filters.filterDateTo,
			projects,
			taskTypes,
		]
	);

	// List view paginates 30 at a time (PROJ-201). Board/backlog operate on the
	// whole working set, so they request a larger page.
	const pageSize = view === "list" ? 30 : 100;

	const fetchIssues = useCallback(async () => {
		const seq = ++fetchSeq.current;
		setLoading(true);
		setError(null);
		try {
			const qs = buildFilterParams();
			qs.set("limit", String(pageSize));
			const data = await apiFetch<{ items: Issue[]; nextCursor: number | null }>(`/api/issues?${qs.toString()}`, {
				workspaceSlug,
			});
			if (seq !== fetchSeq.current) return; // superseded by a newer request
			setIssues(data.items);
			setNextCursor(data.nextCursor ?? null);
			hasLoadedOnce.current = true;
		} catch (e) {
			if (seq !== fetchSeq.current) return;
			setError(String(e));
		} finally {
			if (seq === fetchSeq.current) setLoading(false);
		}
	}, [workspaceSlug, buildFilterParams, pageSize]);

	const loadMore = useCallback(async () => {
		if (nextCursor == null || loadingMore) return;
		setLoadingMore(true);
		setError(null);
		try {
			const qs = buildFilterParams();
			qs.set("limit", String(pageSize));
			qs.set("cursor", String(nextCursor));
			const data = await apiFetch<{ items: Issue[]; nextCursor: number | null }>(`/api/issues?${qs.toString()}`, {
				workspaceSlug,
			});
			setIssues((prev) => [...prev, ...data.items]);
			setNextCursor(data.nextCursor ?? null);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoadingMore(false);
		}
	}, [workspaceSlug, buildFilterParams, pageSize, nextCursor, loadingMore]);

	useEffect(() => {
		fetchIssues();
	}, [fetchIssues]);

	return { issues, setIssues, loading, hasLoadedOnce, error, nextCursor, loadingMore, fetchIssues, loadMore };
}
