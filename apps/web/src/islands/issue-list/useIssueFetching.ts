import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../../utils/api-client";
import type { Issue } from "../board-utils";
import { buildFilterQueryParams, type FilterQueryFilters } from "../IssueList-helpers";
import type { ProjectMeta } from "./types";
import type { ViewMode } from "./types-view";

type FilterInputs = FilterQueryFilters;

// PROJ-862: board/backlog page through at most this many 100-issue pages (5,000 issues).
const BOARD_MAX_PAGES = 50;

type IssuePage = {
	items: Issue[];
	nextCursor: string | number | null;
	total: number | null;
};

const EXPLICIT_FILTER_KEYS = [
	"statusIds",
	"completedAfter",
	"completedBefore",
	"updatedAfter",
	"updatedBefore",
];
const DONE_WINDOW_SECONDS = 14 * 24 * 60 * 60;

function appendUnique(prev: Issue[], next: Issue[]): Issue[] {
	const seen = new Set(prev.map((i) => i.id));
	return [...prev, ...next.filter((i) => !seen.has(i.id) && seen.add(i.id))];
}

function planWalks(view: ViewMode, base: URLSearchParams): URLSearchParams[] {
	if (view === "list" || EXPLICIT_FILTER_KEYS.some((k) => base.has(k))) return [base];
	const open = new URLSearchParams(base);
	open.set("open", "true");
	if (view === "backlog") return [open];
	const done = new URLSearchParams(base);
	done.set("category", "done");
	done.set("completedAfter", String(Math.floor(Date.now() / 1000) - DONE_WINDOW_SECONDS));
	return [open, done];
}

/** Owns the paginated issue set: fetching, "Load more", and loading/error state (PROJ-201/211). */
export function useIssueFetching(
	workspaceSlug: string | undefined,
	view: ViewMode,
	filters: FilterInputs,
	projects: ProjectMeta[],
	taskTypes: Array<{ id: string; key: string; name: string }>,
	lookupsReady = true
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
	const [nextCursor, setNextCursor] = useState<string | number | null>(null);
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
			const base = buildFilterParams();
			base.set("limit", String(pageSize));
			const walks = planWalks(view, base);
			const pages = await Promise.all(
				walks.map((qs) => apiFetch<IssuePage>(`/api/issues?${qs.toString()}`, { workspaceSlug }))
			);
			if (seq !== fetchSeq.current) return; // superseded by a newer request
			setIssues(
				walks.length === 1
					? pages[0].items
					: appendUnique(
							[],
							pages.flatMap((p) => p.items)
						)
			);
			setNextCursor(pages[0].nextCursor ?? null);
			setTotal(pages.reduce((sum, p) => sum + (p.total ?? p.items.length), 0));
			hasLoadedOnce.current = true;
			// PROJ-862: board and backlog show the whole working set — keep paging
			// (the API caps a page at 100) instead of silently stopping at 100.
			if (view !== "list" && pages.some((p) => p.nextCursor != null)) {
				setLoading(false);
				await loadRemainingPages(
					walks,
					pages.map((p) => p.nextCursor ?? null),
					seq
				);
			}
		} catch (e) {
			if (seq !== fetchSeq.current) return;
			setError(String(e));
		} finally {
			if (seq === fetchSeq.current) setLoading(false);
		}
	}, [workspaceSlug, buildFilterParams, pageSize, view]);

	async function loadRemainingPages(
		bases: URLSearchParams[],
		firsts: Array<string | number | null>,
		seq: number
	) {
		setLoadingMore(true);
		try {
			for (let i = 0; i < bases.length; i++) {
				let cursor = firsts[i];
				setNextCursor(cursor);
				for (let page = 0; cursor != null && page < BOARD_MAX_PAGES; page++) {
					const qs = new URLSearchParams(bases[i]);
					qs.set("cursor", String(cursor));
					const data: IssuePage = await apiFetch(`/api/issues?${qs.toString()}`, {
						workspaceSlug,
					});
					if (seq !== fetchSeq.current) return;
					setIssues((prev) => appendUnique(prev, data.items));
					cursor = data.nextCursor ?? null;
					setNextCursor(cursor);
				}
			}
		} finally {
			if (seq === fetchSeq.current) setLoadingMore(false);
		}
	}

	const loadMore = useCallback(async () => {
		if (nextCursor == null || loadingMore) return;
		setLoadingMore(true);
		setError(null);
		try {
			const qs = buildFilterParams();
			qs.set("limit", String(pageSize));
			qs.set("cursor", String(nextCursor));
			const data = await apiFetch<{
				items: Issue[];
				nextCursor: string | number | null;
				total: number | null;
			}>(`/api/issues?${qs.toString()}`, {
				workspaceSlug,
			});
			setIssues((prev) => [...prev, ...data.items]);
			setNextCursor(data.nextCursor ?? null);
			// PROJ-857: later pages return total: null — keep the first page's count.
			setTotal((prev) => data.total ?? prev);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoadingMore(false);
		}
	}, [workspaceSlug, buildFilterParams, pageSize, nextCursor, loadingMore]);

	useEffect(() => {
		if (!lookupsReady) return;
		fetchIssues();
	}, [fetchIssues, lookupsReady]);

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
