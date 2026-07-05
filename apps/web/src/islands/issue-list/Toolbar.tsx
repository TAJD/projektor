import type { RefObject } from "preact";
import type { Dispatch, StateUpdater } from "preact/hooks";
import type { Issue, SortKey, TaskStatus } from "../board-utils";
import Select from "../Select";
import type { DateField } from "./FiltersPopover";
import FiltersPopover from "./FiltersPopover";
import SavedViewsControl from "./SavedViewsControl";
import SearchBox from "./SearchBox";
import type { useSavedViews } from "./useSavedViews";

interface FilterSelectsProps {
	uniqueProjects: Array<{ key: string; name: string }>;
	filterProject: string;
	setFilterProject: (v: string) => void;
	setFilterSprintId: Dispatch<StateUpdater<string>>;
	sprints: Array<{ id: string; name: string; status: string }>;
	filterSprintId: string;
	uniqueTypes: Array<[string, string]>;
	filterType: string;
	setFilterType: (v: string) => void;
	epics: Issue[];
	filterEpicId: string;
	setFilterEpicId: (v: string) => void;
	hideEpics: boolean;
	setHideEpics: (v: boolean) => void;
}

function FilterSelects({
	uniqueProjects,
	filterProject,
	setFilterProject,
	setFilterSprintId,
	sprints,
	filterSprintId,
	uniqueTypes,
	filterType,
	setFilterType,
	epics,
	filterEpicId,
	setFilterEpicId,
	hideEpics,
	setHideEpics,
}: FilterSelectsProps) {
	return (
		<>
			{uniqueProjects.length > 0 && (
				<Select
					ariaLabel="Filter by project"
					value={filterProject}
					onChange={(v) => {
						setFilterProject(v);
						setFilterSprintId("");
					}}
					options={[{ value: "", label: "All projects" }, ...uniqueProjects.map((p) => ({ value: p.key, label: p.name }))]}
				/>
			)}

			{sprints.length > 0 && (
				<Select
					ariaLabel="Filter by sprint"
					value={filterSprintId}
					onChange={setFilterSprintId}
					options={[
						{ value: "", label: "All sprints" },
						...sprints.map((s) => ({ value: s.id, label: `${s.status === "active" ? "● " : ""}${s.name}` })),
					]}
				/>
			)}

			{uniqueTypes.length > 0 && (
				<Select
					ariaLabel="Filter by type"
					value={filterType}
					onChange={setFilterType}
					options={[{ value: "", label: "All types" }, ...uniqueTypes.map(([key, name]) => ({ value: key, label: name }))]}
				/>
			)}

			{epics.length > 0 && (
				<Select
					ariaLabel="Filter by epic"
					value={filterEpicId}
					onChange={setFilterEpicId}
					options={[
						{ value: "", label: "All epics" },
						{ value: "none", label: "No epic" },
						...epics.map((epic) => ({
							value: epic.id,
							label: `${epic.project_key ? `${epic.project_key}-${epic.number}` : `#${epic.number}`} ${epic.title}`,
						})),
					]}
				/>
			)}

			{epics.length > 0 && (
				<label class="flex items-center gap-1.5 text-[0.8rem] text-text-muted whitespace-nowrap cursor-pointer select-none">
					<input
						type="checkbox"
						checked={hideEpics}
						onChange={(e) => setHideEpics((e.target as HTMLInputElement).checked)}
					/>
					Hide epics
				</label>
			)}
		</>
	);
}

function SortControls({
	sortBy,
	setSortBy,
	sortDir,
	setSortDir,
}: {
	sortBy: SortKey;
	setSortBy: (v: SortKey) => void;
	sortDir: "asc" | "desc";
	setSortDir: Dispatch<StateUpdater<"asc" | "desc">>;
}) {
	return (
		<span class="ml-auto max-sm:ml-0 max-sm:w-full flex gap-2 items-center flex-wrap">
			<span class="text-sm text-text-muted">Sort:</span>
			<Select
				ariaLabel="Sort by"
				value={sortBy}
				onChange={(v) => setSortBy(v as SortKey)}
				options={[
					{ value: "created_at", label: "Created" },
					{ value: "updated", label: "Updated" },
					{ value: "priority", label: "Priority" },
					{ value: "status", label: "Status" },
					{ value: "title", label: "Title" },
					{ value: "assignee", label: "Assignee" },
					{ value: "number", label: "Number" },
				]}
			/>
			<button
				type="button"
				aria-label={sortDir === "asc" ? "Sort descending" : "Sort ascending"}
				onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
				class="btn btn-outline btn-sm"
			>
				{sortDir === "asc" ? "↑" : "↓"}
			</button>
		</span>
	);
}

interface ToolbarProps extends FilterSelectsProps {
	searchQuery: string;
	setSearchQuery: (v: string) => void;
	isSearchActive: boolean;
	searchInputRef: RefObject<HTMLInputElement>;

	derivedStatuses: TaskStatus[];
	filterStatuses: string[];
	setFilterStatuses: Dispatch<StateUpdater<string[]>>;
	filterPriorities: string[];
	setFilterPriorities: Dispatch<StateUpdater<string[]>>;
	filterDateField: DateField;
	setFilterDateField: Dispatch<StateUpdater<DateField>>;
	filterDateFrom: string;
	setFilterDateFrom: Dispatch<StateUpdater<string>>;
	filterDateTo: string;
	setFilterDateTo: Dispatch<StateUpdater<string>>;

	saved: ReturnType<typeof useSavedViews>;

	sortBy: SortKey;
	setSortBy: (v: SortKey) => void;
	sortDir: "asc" | "desc";
	setSortDir: Dispatch<StateUpdater<"asc" | "desc">>;
}

export default function Toolbar(props: ToolbarProps) {
	const {
		searchQuery,
		setSearchQuery,
		isSearchActive,
		searchInputRef,
		derivedStatuses,
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		filterDateField,
		setFilterDateField,
		filterDateFrom,
		setFilterDateFrom,
		filterDateTo,
		setFilterDateTo,
		saved,
		sortBy,
		setSortBy,
		sortDir,
		setSortDir,
	} = props;

	return (
		<div
			class={[
				"flex gap-2 flex-wrap items-center mb-4 p-3 bg-surface rounded-lg border border-border",
				"shadow-[var(--shadow-sm)]",
			].join(" ")}
		>
			<SearchBox
				searchQuery={searchQuery}
				setSearchQuery={setSearchQuery}
				isSearchActive={isSearchActive}
				searchInputRef={searchInputRef}
			/>

			<FiltersPopover
				derivedStatuses={derivedStatuses}
				filterStatuses={filterStatuses}
				setFilterStatuses={setFilterStatuses}
				filterPriorities={filterPriorities}
				setFilterPriorities={setFilterPriorities}
				filterDateField={filterDateField}
				setFilterDateField={setFilterDateField}
				filterDateFrom={filterDateFrom}
				setFilterDateFrom={setFilterDateFrom}
				filterDateTo={filterDateTo}
				setFilterDateTo={setFilterDateTo}
				isSearchActive={isSearchActive}
			/>

			<FilterSelects {...props} />

			<SavedViewsControl saved={saved} />

			<SortControls sortBy={sortBy} setSortBy={setSortBy} sortDir={sortDir} setSortDir={setSortDir} />
		</div>
	);
}
