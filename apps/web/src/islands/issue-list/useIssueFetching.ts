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
	// Pagination (PROJ-201/303): list view loads 30 at a time and appends automatically
	// as the user scrolls near the bottom (see useInfiniteScroll / ListSection).
	const [nextCursor, setNextCursor] = useState<number | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	// Real total matching the current filters (server-computed), not just how many
	// have been loaded so far — PROJ-303: the header count must never look capped.
	const [total, setTotal] = useState(0);

	// Build the filter query params shared by the initial fetch and "Load more"
	// (everything except limit/cursor, which the callers set). Keyed on the
	// *serialized* params, not input identities: the filter arrays and lookup
	// lists get fresh identities on mount/arrival without changing the resulting
	// query, and each identity change used to refire the issues fetch — 4
	// byte-identical GETs per page load.
	const filterQs = buildFilterQueryParams(filters, projects, taskTypes).toString();
	const buildFilterParams = useCallback(() => new URLSearchParams(filterQs), [filterQs]);

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
			const data = await apiFetch<{ items: Issue[]; nextCursor: number | null; total: number }>(
				`/api/issues?${qs.toString()}`,
				{
					workspaceSlug,
				}
			);
			if (seq !== fetchSeq.current) return; // superseded by a newer request
			setIssues(data.items);
			setNextCursor(data.nextCursor ?? null);
			setTotal(data.total ?? data.items.length);
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
			const data = await apiFetch<{ items: Issue[]; nextCursor: number | null; total: number }>(
				`/api/issues?${qs.toString()}`,
				{
					workspaceSlug,
				}
			);
			setIssues((prev) => [...prev, ...data.items]);
			setNextCursor(data.nextCursor ?? null);
			setTotal(data.total ?? 0);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoadingMore(false);
		}
	}, [workspaceSlug, buildFilterParams, pageSize, nextCursor, loadingMore]);

	useEffect(() => {
		fetchIssues();
	}, [fetchIssues]);

	// cofferdam-ignore: Consistency.ErrorHandlingIdiom: hook returns {data,error,loading} state, standard in this codebase
	return {
		issues,
		setIssues,
		loading,
		hasLoadedOnce,
		error,
		nextCursor,
		loadingMore,
		total,
		fetchIssues,
		loadMore,
	};
}
