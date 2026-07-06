import type { Issue } from "../board-utils";
import CreateIssueModal from "./CreateIssueModal";
import { deriveProjectOptions, deriveStatusOptions, deriveTypeOptions } from "./derive";
import HeaderRow from "./HeaderRow";
import MainContent from "./MainContent";
import SprintBannerSection from "./SprintBannerSection";
import Toolbar from "./Toolbar";
import type { ViewMode } from "./types-view";
import type { useCreateIssueModal } from "./useCreateIssueModal";
import type { useIssueFilters } from "./useIssueFilters";
import type { useIssueListData } from "./useIssueListData";
import type { useIssueSearch } from "./useIssueSearch";
import type { useSavedViews } from "./useSavedViews";

interface IssueListLayoutProps {
	workspaceSlug?: string;
	view: ViewMode;
	setView: (v: ViewMode) => void;
	filtered: Issue[];
	projectDescription: string | null;
	filters: ReturnType<typeof useIssueFilters>;
	search: ReturnType<typeof useIssueSearch>;
	data: ReturnType<typeof useIssueListData>;
	saved: ReturnType<typeof useSavedViews>;
	createModal: ReturnType<typeof useCreateIssueModal>;
}

/** Banners + toolbar + count/view-toggle row — everything above the main content area. */
function IssueListTop({
	workspaceSlug,
	view,
	setView,
	filtered,
	projectDescription,
	filters,
	search,
	data,
	saved,
	createModal,
}: IssueListLayoutProps) {
	return (
		<>
			{/* Project description banner — shown when filtering by a specific project */}
			{filters.filterProject && projectDescription && (
				<p
					class={[
						"mb-4 px-[0.875rem] py-[0.625rem] bg-surface border border-border rounded-md text-sm",
						"text-text-muted leading-[1.5]",
					].join(" ")}
				>
					{projectDescription}
				</p>
			)}

			{/* Sprint banner — shown when filtering by a specific sprint */}
			<SprintBannerSection
				filterSprintId={filters.filterSprintId}
				sprintDetail={data.sprintDetail}
				setSprintDetail={data.setSprintDetail}
				setSprints={data.setSprints}
				setFilterSprintId={filters.setFilterSprintId}
				workspaceSlug={workspaceSlug}
				issues={data.issues}
			/>

			{data.updateError && (
				<p role="alert" class="text-[var(--danger-text)] mb-2">
					{data.updateError}
				</p>
			)}

			<Toolbar
				searchQuery={search.searchQuery}
				setSearchQuery={search.setSearchQuery}
				isSearchActive={search.isSearchActive}
				searchInputRef={search.searchInputRef}
				derivedStatuses={deriveStatusOptions(data.issues, data.statuses)}
				filterStatuses={filters.filterStatuses}
				setFilterStatuses={filters.setFilterStatuses}
				filterPriorities={filters.filterPriorities}
				setFilterPriorities={filters.setFilterPriorities}
				filterDateField={filters.filterDateField}
				setFilterDateField={filters.setFilterDateField}
				filterDateFrom={filters.filterDateFrom}
				setFilterDateFrom={filters.setFilterDateFrom}
				filterDateTo={filters.filterDateTo}
				setFilterDateTo={filters.setFilterDateTo}
				uniqueProjects={deriveProjectOptions(data.issues)}
				filterProject={filters.filterProject}
				setFilterProject={filters.setFilterProject}
				setFilterSprintId={filters.setFilterSprintId}
				sprints={data.sprints}
				filterSprintId={filters.filterSprintId}
				uniqueTypes={deriveTypeOptions(data.issues)}
				filterType={filters.filterType}
				setFilterType={filters.setFilterType}
				epics={data.epics}
				filterEpicId={filters.filterEpicId}
				setFilterEpicId={filters.setFilterEpicId}
				hideEpics={filters.hideEpics}
				setHideEpics={filters.setHideEpics}
				saved={saved}
				sortBy={filters.sortBy}
				setSortBy={filters.setSortBy}
				sortDir={filters.sortDir}
				setSortDir={filters.setSortDir}
			/>

			<HeaderRow
				isSearchActive={search.isSearchActive}
				searchResults={search.searchResults}
				searchQuery={search.searchQuery}
				view={view}
				setView={setView}
				filtered={filtered}
				totalIssues={data.total}
				projectsCount={data.projects.length}
				openCreateModal={createModal.openCreateModal}
			/>
		</>
	);
}

/** Main content area (search/board/backlog/list) + the create-issue modal. */
function IssueListMain({
	view,
	filtered,
	search,
	data,
	filters,
	createModal,
}: IssueListLayoutProps) {
	return (
		<>
			<MainContent
				isSearchActive={search.isSearchActive}
				searchLoading={search.searchLoading}
				searchResults={search.searchResults}
				searchQuery={search.searchQuery}
				view={view}
				issues={filtered}
				statuses={data.statuses}
				updatingId={data.updatingId}
				updatingPriorityId={data.updatingPriorityId}
				changeStatus={data.changeStatus}
				changePriority={data.changePriority}
				sortBy={filters.sortBy}
				sortDir={filters.sortDir}
				onSort={filters.handleHeaderClick}
				nextCursor={data.nextCursor}
				loadingMore={data.loadingMore}
				loadMore={data.loadMore}
			/>

			{/* Create issue modal (PROJ-62) */}
			{createModal.showCreateModal && (
				<CreateIssueModal
					createTitle={createModal.createTitle}
					setCreateTitle={createModal.setCreateTitle}
					createBody={createModal.createBody}
					setCreateBody={createModal.setCreateBody}
					createPriority={createModal.createPriority}
					setCreatePriority={createModal.setCreatePriority}
					createProjectId={createModal.createProjectId}
					setCreateProjectId={createModal.setCreateProjectId}
					createTypeId={createModal.createTypeId}
					setCreateTypeId={createModal.setCreateTypeId}
					createStatusId={createModal.createStatusId}
					setCreateStatusId={createModal.setCreateStatusId}
					createError={createModal.createError}
					submittingCreate={createModal.submittingCreate}
					submitCreate={createModal.submitCreate}
					setShowCreateModal={createModal.setShowCreateModal}
					projects={data.projects}
					taskTypes={data.taskTypes}
					statuses={data.statuses}
				/>
			)}
		</>
	);
}

/** Assembles the toolbar, header, main content, and modals from the parent list's hook state. */
export default function IssueListLayout(props: IssueListLayoutProps) {
	return (
		<div>
			<IssueListTop {...props} />
			<IssueListMain {...props} />
		</div>
	);
}
