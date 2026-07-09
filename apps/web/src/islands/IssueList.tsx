import { useEffect, useState } from "preact/hooks";
import { useAccessGate } from "../utils/access-gate";
import AccessPending from "./AccessPending";
import { sortIssues } from "./board-utils";
import { deriveProjectDescription } from "./issue-list/derive";
import IssueListLayout from "./issue-list/IssueListLayout";
import type { ViewMode } from "./issue-list/types-view";
import { useCreateIssueModal } from "./issue-list/useCreateIssueModal";
import { useIssueFilters } from "./issue-list/useIssueFilters";
import { useIssueListData } from "./issue-list/useIssueListData";
import { useIssueSearch } from "./issue-list/useIssueSearch";
import { useSavedViews } from "./issue-list/useSavedViews";

interface Props {
	workspaceSlug?: string;
}

export default function IssueList({ workspaceSlug }: Props) {
	const [view, setView] = useState<ViewMode>("list");

	// safe-ls: cosmetic view preference (list/board/backlog). No API dependency — a stale
	// or missing value falls back to the "list" default; it never influences API requests.
	useEffect(() => {
		const stored = localStorage.getItem("issues-view") as ViewMode | null;
		if (stored === "list" || stored === "board" || stored === "backlog") setView(stored);
	}, []);

	// safe-ls: cosmetic view preference — no API dependency (see getItem above).
	useEffect(() => {
		localStorage.setItem("issues-view", view);
	}, [view]);

	const gate = useAccessGate(workspaceSlug);
	const filters = useIssueFilters();
	const search = useIssueSearch(workspaceSlug);
	const data = useIssueListData(workspaceSlug, view, {
		filterStatuses: filters.filterStatuses,
		filterPriorities: filters.filterPriorities,
		filterProject: filters.filterProject,
		filterType: filters.filterType,
		filterEpicId: filters.filterEpicId,
		filterSprintId: filters.filterSprintId,
		hideEpics: filters.hideEpics,
		filterDateField: filters.filterDateField,
		filterDateFrom: filters.filterDateFrom,
		filterDateTo: filters.filterDateTo,
	});
	const saved = useSavedViews(filters.filterProject, filters.filtersBundle, filters.applyFilters);
	const createModal = useCreateIssueModal({
		workspaceSlug,
		filterProject: filters.filterProject,
		projects: data.projects,
		statuses: data.statuses,
		taskTypes: data.taskTypes,
		setIssues: data.setIssues,
	});

	// Filtering happens server-side (PROJ-211): `issues` is already the filtered,
	// paginated result set, so the client only sorts the loaded rows. (Sorting is
	// still page-local — tracked separately as a follow-up.)
	const filtered = sortIssues(data.issues, filters.sortBy, filters.sortDir);

	if (gate.pending) return <AccessPending />;
	if (data.loading && !data.hasLoadedOnce.current) return <p aria-live="polite">Loading issues…</p>;
	if (data.error) {
		return (
			<p role="alert" style={{ color: "var(--danger-text)" }}>
				Failed to load issues: {data.error}
			</p>
		);
	}

	return (
		<IssueListLayout
			workspaceSlug={workspaceSlug}
			view={view}
			setView={setView}
			filtered={filtered}
			projectDescription={deriveProjectDescription(data.projects, filters.filterProject)}
			filters={filters}
			search={search}
			data={data}
			saved={saved}
			createModal={createModal}
		/>
	);
}
