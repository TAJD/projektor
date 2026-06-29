import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { formatIssueRef } from "../lib/issue-ref";
import { statusDisplayName } from "../lib/status";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import { PRIORITY_OPTIONS } from "../utils/issue-utils";
import {
	assigneeInitials,
	BOARD_COLUMNS,
	categoryColor,
	filterIssues,
	getBacklogIssues,
	getBoardColumnIssues,
	getFirstStatusForCategory,
	type Issue,
	type SortKey,
	sortIssues,
	type TaskStatus,
} from "./board-utils";
import MarkdownEditor from "./MarkdownEditor";
import Select from "./Select";

interface Props {
	workspaceSlug?: string;
}

type ViewMode = "list" | "board" | "backlog";

interface ProjectMeta {
	id: string;
	key: string;
	name: string;
	description: string | null;
}

interface SearchResult {
	id: string;
	number: number;
	title: string;
	status: string;
	priority: string;
	project_id: string | null;
	project_key: string | null;
	project_name: string | null;
}

interface SavedView {
	name: string;
	filters: {
		statuses: string[];
		priorities: string[];
		project: string;
		type: string;
		epicId: string;
		sprintId: string;
	};
}

interface SprintDetail {
	id: string;
	name: string;
	status: "planned" | "active" | "completed";
	startDate: number | null;
	endDate: number | null;
	goal: string | null;
	projectId: string;
}

function getStoryPoints(issue: Issue): string | null {
	const field = (issue.customFields ?? []).find((f) => f.key === "story_points");
	return field?.value ?? null;
}

function tsToDateInput(ts: number): string {
	const d = new Date(ts * 1000);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function spBadge(pts: string) {
	return (
		<span class="text-[0.68rem] text-text-muted bg-surface border border-border rounded-[3px] px-[0.3rem] font-semibold whitespace-nowrap leading-[1.6]">
			{pts} SP
		</span>
	);
}

export default function IssueList({ workspaceSlug }: Props) {
	const [issues, setIssues] = useState<Issue[]>([]);
	const [statuses, setStatuses] = useState<TaskStatus[]>([]);
	const [projects, setProjects] = useState<ProjectMeta[]>([]);
	const [loading, setLoading] = useState(true);
	const hasLoadedOnce = useRef(false);
	const [error, setError] = useState<string | null>(null);

	const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
	const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
	const [filterProject, setFilterProject] = useState("");
	const [filterType, setFilterType] = useState("");
	const [filterEpicId, setFilterEpicId] = useState("");
	const [hideEpics, setHideEpics] = useState(false);
	const [filterSprintId, setFilterSprintId] = useState("");
	const [sortBy, setSortBy] = useState<SortKey>("created_at");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
	const [sprints, setSprints] = useState<Array<{ id: string; name: string; status: string }>>([]);
	const [sprintDetail, setSprintDetail] = useState<SprintDetail | null>(null);
	const [sprintEditing, setSprintEditing] = useState(false);
	const [sprintEditName, setSprintEditName] = useState("");
	const [sprintEditGoal, setSprintEditGoal] = useState("");
	const [sprintEditStatus, setSprintEditStatus] = useState<"planned" | "active" | "completed">(
		"planned"
	);
	const [sprintEditStart, setSprintEditStart] = useState("");
	const [sprintEditEnd, setSprintEditEnd] = useState("");
	const [sprintEditSaving, setSprintEditSaving] = useState(false);
	const [sprintEditError, setSprintEditError] = useState<string | null>(null);

	const [updatingId, setUpdatingId] = useState<string | null>(null);
	const [updatingPriorityId, setUpdatingPriorityId] = useState<string | null>(null);
	const [updateError, setUpdateError] = useState<string | null>(null);

	const [view, setView] = useState<ViewMode>("list");
	const [dragIssueId, setDragIssueId] = useState<string | null>(null);
	const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

	// Backlog drag-to-reorder state (PROJ-143)
	const [backlogOrder, setBacklogOrder] = useState<string[]>([]);
	const [backlogDragId, setBacklogDragId] = useState<string | null>(null);
	const [backlogDragOverId, setBacklogDragOverId] = useState<string | null>(null);

	// Search state (PROJ-110)
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
	const [searchLoading, setSearchLoading] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Saved views state (PROJ-141)
	const [savedViews, setSavedViews] = useState<SavedView[]>([]);
	const [activeViewName, setActiveViewName] = useState<string | null>(null);
	const [showSaveInput, setShowSaveInput] = useState(false);
	const [saveViewName, setSaveViewName] = useState("");
	const [showViewsMenu, setShowViewsMenu] = useState(false);
	const viewsContainerRef = useRef<HTMLDivElement>(null);
	const viewsMenuRef = useRef<HTMLUListElement>(null);
	const viewsButtonRef = useRef<HTMLButtonElement>(null);
	const viewsMenuPos = useRef<{ top: number; left: number; width: number }>({
		top: 0,
		left: 0,
		width: 0,
	});

	// Filters popover state
	const [showFiltersPopover, setShowFiltersPopover] = useState(false);
	const filtersContainerRef = useRef<HTMLDivElement>(null);
	const filtersPopoverRef = useRef<HTMLDivElement>(null);
	const filtersButtonRef = useRef<HTMLButtonElement>(null);
	const filtersPopoverPos = useRef<{ top: number; left: number }>({ top: 0, left: 0 });

	// Create modal state (PROJ-62)
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createBody, setCreateBody] = useState("");
	const [createPriority, setCreatePriority] = useState("medium");
	const [createStatusId, setCreateStatusId] = useState("");
	const [createProjectId, setCreateProjectId] = useState("");
	const [createTypeId, setCreateTypeId] = useState("");
	const [taskTypes, setTaskTypes] = useState<Array<{ id: string; key: string; name: string }>>([]);
	const [submittingCreate, setSubmittingCreate] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	const fetchIssues = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const qs = new URLSearchParams({ limit: "100" });
			if (filterStatuses.length) qs.set("statusIds", filterStatuses.join(","));
			if (filterPriorities.length) qs.set("priorities", filterPriorities.join(","));
			const projectId = filterProject
				? projects.find((p) => p.key === filterProject)?.id
				: undefined;
			if (projectId) qs.set("project", projectId);
			const typeId = filterType ? taskTypes.find((t) => t.key === filterType)?.id : undefined;
			if (typeId) qs.set("typeId", typeId);
			if (filterEpicId && filterEpicId !== "none") qs.set("parentId", filterEpicId);
			if (filterEpicId === "none") qs.set("noParent", "true");
			if (filterSprintId) qs.set("sprintId", filterSprintId);
			const qStr = qs.toString();
			const data = await apiFetch<{ items: Issue[] }>(`/api/issues${qStr ? `?${qStr}` : ""}`, {
				workspaceSlug,
			});
			setIssues(data.items);
			hasLoadedOnce.current = true;
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [
		workspaceSlug,
		filterStatuses,
		filterPriorities,
		filterProject,
		filterType,
		filterEpicId,
		filterSprintId,
		projects,
		taskTypes,
	]);

	// Read initial filter state from URL params on mount; also load persisted view.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const s = params.get("status");
		const p = params.get("priority");
		const proj = params.get("project");
		const e = params.get("epic");
		const spr = params.get("sprintId");
		if (s) setFilterStatuses(s.split(",").filter(Boolean));
		if (p) setFilterPriorities(p.split(",").filter(Boolean));
		if (proj) setFilterProject(proj);
		if (e) setFilterEpicId(e);
		if (spr) setFilterSprintId(spr);
		if (params.get("hideEpics") === "1") setHideEpics(true);

		// safe-ls: cosmetic view preference (list/board/backlog). No API dependency — a stale
		// or missing value falls back to the "list" default; it never influences API requests.
		const stored = localStorage.getItem("issues-view") as ViewMode | null;
		if (stored === "list" || stored === "board" || stored === "backlog") setView(stored);
	}, []);

	// Sync filter state back to URL without page reload.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		if (filterStatuses.length > 0) {
			params.set("status", filterStatuses.join(","));
		} else {
			params.delete("status");
		}
		if (filterPriorities.length > 0) {
			params.set("priority", filterPriorities.join(","));
		} else {
			params.delete("priority");
		}
		if (filterEpicId) {
			params.set("epic", filterEpicId);
		} else {
			params.delete("epic");
		}
		if (filterSprintId) {
			params.set("sprintId", filterSprintId);
		} else {
			params.delete("sprintId");
		}
		if (hideEpics) {
			params.set("hideEpics", "1");
		} else {
			params.delete("hideEpics");
		}
		const qs = params.toString();
		history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
	}, [filterStatuses, filterPriorities, filterEpicId, filterSprintId, hideEpics]);

	// safe-ls: cosmetic view preference — no API dependency (see getItem above).
	useEffect(() => {
		localStorage.setItem("issues-view", view);
	}, [view]);

	useEffect(() => {
		fetchIssues();
	}, [fetchIssues]);

	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<TaskStatus[]>("/api/task-statuses", { workspaceSlug });
				if (Array.isArray(data)) setStatuses(data);
			} catch {
				// non-fatal — status filter will derive from issue data
			}
		})();
	}, [workspaceSlug]);

	// Fetch task types for the create modal type selector (PROJ-157)
	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<Array<{ id: string; key: string; name: string }>>(
					"/api/task-types",
					{ workspaceSlug }
				);
				if (Array.isArray(data)) setTaskTypes(data);
			} catch {
				// non-fatal
			}
		})();
	}, [workspaceSlug]);

	// Fetch project list for create modal + description lookup
	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<ProjectMeta[]>("/api/projects", { workspaceSlug });
				if (Array.isArray(data)) setProjects(data);
			} catch {
				// non-fatal
			}
		})();
	}, [workspaceSlug]);

	// Fetch project's sprints when project filter is active, or when a sprintId is set
	// (so the sprint selector appears even when navigating directly to a ?sprintId= URL).
	useEffect(() => {
		const fallbackProjectId = !filterProject && sprintDetail ? sprintDetail.projectId : null;
		if (!filterProject && !fallbackProjectId) {
			setSprints([]);
			return;
		}
		(async () => {
			try {
				let projectId: string;
				if (fallbackProjectId) {
					projectId = fallbackProjectId;
				} else {
					const allProjects = await apiFetch<Array<{ id: string; key: string }>>("/api/projects", {
						workspaceSlug,
					});
					const proj = allProjects.find((p) => p.key === filterProject);
					if (!proj) return;
					projectId = proj.id;
				}
				const data = await apiFetch<{ items: Array<{ id: string; name: string; status: string }> }>(
					`/api/sprints?projectId=${encodeURIComponent(projectId)}`,
					{ workspaceSlug }
				);
				setSprints(Array.isArray(data?.items) ? data.items : []);
			} catch {
				// non-fatal
			}
		})();
	}, [filterProject, sprintDetail, workspaceSlug]);

	// Fetch sprint details when a sprintId filter is active, for the sprint banner.
	useEffect(() => {
		if (!filterSprintId) {
			setSprintDetail(null);
			setSprintEditing(false);
			return;
		}
		(async () => {
			try {
				const data = await apiFetch<SprintDetail>(`/api/sprints/${filterSprintId}`, {
					workspaceSlug,
				});
				setSprintDetail(data);
			} catch {
				// non-fatal
			}
		})();
	}, [filterSprintId, workspaceSlug]);

	// Escape closes the create modal
	useEffect(() => {
		if (!showCreateModal) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setShowCreateModal(false);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [showCreateModal]);

	// Debounced search (PROJ-110)
	useEffect(() => {
		const q = searchQuery.trim();
		if (!q) {
			setSearchResults(null);
			setSearchLoading(false);
			return;
		}
		setSearchLoading(true);
		const timer = setTimeout(async () => {
			try {
				const params = new URLSearchParams({ q });
				const data = await apiFetch<SearchResult[]>(`/api/issues/search?${params}`, {
					workspaceSlug,
				});
				setSearchResults(Array.isArray(data) ? data : []);
			} catch {
				setSearchResults([]);
			} finally {
				setSearchLoading(false);
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery, workspaceSlug]);

	// Load saved views from localStorage when the project context changes (PROJ-141)
	useEffect(() => {
		const key = `issue-views-${filterProject || "all"}`;
		try {
			const raw = localStorage.getItem(key);
			setSavedViews(raw ? (JSON.parse(raw) as SavedView[]) : []);
		} catch {
			setSavedViews([]);
		}
	}, [filterProject]);

	// Close views menu on outside click (PROJ-141)
	useEffect(() => {
		if (!showViewsMenu) return;
		function onPointer(e: MouseEvent) {
			const target = e.target as Node;
			if (!viewsContainerRef.current?.contains(target) && !viewsMenuRef.current?.contains(target)) {
				setShowViewsMenu(false);
			}
		}
		document.addEventListener("mousedown", onPointer);
		return () => document.removeEventListener("mousedown", onPointer);
	}, [showViewsMenu]);

	// Close filters popover on outside click
	useEffect(() => {
		if (!showFiltersPopover) return;
		function onPointer(e: MouseEvent) {
			const target = e.target as Node;
			if (
				!filtersContainerRef.current?.contains(target) &&
				!filtersPopoverRef.current?.contains(target)
			) {
				setShowFiltersPopover(false);
			}
		}
		document.addEventListener("mousedown", onPointer);
		return () => document.removeEventListener("mousedown", onPointer);
	}, [showFiltersPopover]);

	// Clear active view name when filters drift from the saved state (PROJ-141)
	useEffect(() => {
		if (!activeViewName) return;
		const activeView = savedViews.find((v) => v.name === activeViewName);
		if (!activeView) {
			setActiveViewName(null);
			return;
		}
		const f = activeView.filters;
		const matches =
			JSON.stringify([...filterStatuses].sort()) === JSON.stringify([...f.statuses].sort()) &&
			JSON.stringify([...filterPriorities].sort()) === JSON.stringify([...f.priorities].sort()) &&
			filterProject === f.project &&
			filterType === f.type &&
			filterEpicId === f.epicId &&
			filterSprintId === f.sprintId;
		if (!matches) setActiveViewName(null);
	}, [
		filterStatuses,
		filterPriorities,
		filterProject,
		filterType,
		filterEpicId,
		filterSprintId,
		activeViewName,
		savedViews,
	]);

	async function changeStatus(issueId: string, statusId: string) {
		const status = statuses.find((s) => s.id === statusId);
		if (!status) return;

		setUpdateError(null);

		// Optimistic update
		setIssues((prev) =>
			prev.map((i) =>
				i.id === issueId
					? {
							...i,
							status_id: status.id,
							status_key: status.key,
							status_name: status.name,
							status_category: status.category,
						}
					: i
			)
		);

		setUpdatingId(issueId);
		try {
			await apiFetch(`/api/issues/${issueId}`, {
				method: "PATCH",
				workspaceSlug,
				body: { statusId },
			});
		} catch (e) {
			setUpdateError(`Status update failed: ${String(e)}`);
			// Revert by refetching authoritative data
			await fetchIssues();
		} finally {
			setUpdatingId(null);
		}
	}

	async function changePriority(issueId: string, priority: string) {
		setUpdateError(null);

		// Optimistic update
		setIssues((prev) => prev.map((i) => (i.id === issueId ? { ...i, priority } : i)));

		setUpdatingPriorityId(issueId);
		try {
			await apiFetch(`/api/issues/${issueId}`, {
				method: "PATCH",
				workspaceSlug,
				body: { priority },
			});
		} catch (e) {
			setUpdateError(`Priority update failed: ${String(e)}`);
			await fetchIssues();
		} finally {
			setUpdatingPriorityId(null);
		}
	}

	function openCreateModal() {
		const targetProjectId = filterProject
			? (projects.find((p) => p.key === filterProject)?.id ?? projects[0]?.id ?? "")
			: (projects[0]?.id ?? "");
		setCreateProjectId(targetProjectId);
		setCreateTitle("");
		setCreateBody("");
		setCreatePriority("medium");
		setCreateStatusId("");
		setCreateTypeId("");
		setCreateError(null);
		setShowCreateModal(true);
	}

	async function submitCreate(e: Event) {
		e.preventDefault();
		if (!createTitle.trim() || !createProjectId) return;
		setSubmittingCreate(true);
		setCreateError(null);
		try {
			const created = await apiFetch<{ id: string; number: number }>("/api/issues", {
				method: "POST",
				workspaceSlug,
				body: {
					projectId: createProjectId,
					title: createTitle.trim(),
					body: createBody || undefined,
					priority: createPriority,
					statusId: createStatusId || undefined,
					typeId: createTypeId || undefined,
				},
			});

			// Build a minimal Issue to prepend optimistically
			const proj = projects.find((p) => p.id === createProjectId);
			const chosenStatus = statuses.find((s) => s.id === createStatusId);
			const chosenType = taskTypes.find((t) => t.id === createTypeId);
			const now = Math.floor(Date.now() / 1000);
			const newIssue: Issue = {
				id: created.id,
				number: created.number,
				title: createTitle.trim(),
				priority: createPriority,
				assignee_id: null,
				assignee_name: null,
				parent_id: null,
				project_id: createProjectId,
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
			setIssues((prev) => [newIssue, ...prev]);
			setShowCreateModal(false);
		} catch (e) {
			setCreateError(`Failed to create issue: ${String(e)}`);
		} finally {
			setSubmittingCreate(false);
		}
	}

	// Saved view management (PROJ-141)
	function doSaveView() {
		const name = saveViewName.trim();
		if (!name) return;
		const newView: SavedView = {
			name,
			filters: {
				statuses: filterStatuses,
				priorities: filterPriorities,
				project: filterProject,
				type: filterType,
				epicId: filterEpicId,
				sprintId: filterSprintId,
			},
		};
		const key = `issue-views-${filterProject || "all"}`;
		const updated = [...savedViews.filter((v) => v.name !== name), newView];
		setSavedViews(updated);
		// safe-ls: cosmetic filter preference, no API dependency
		localStorage.setItem(key, JSON.stringify(updated));
		setActiveViewName(name);
		setSaveViewName("");
		setShowSaveInput(false);
	}

	function deleteView(name: string) {
		const key = `issue-views-${filterProject || "all"}`;
		const updated = savedViews.filter((v) => v.name !== name);
		setSavedViews(updated);
		// safe-ls: cosmetic filter preference, no API dependency
		localStorage.setItem(key, JSON.stringify(updated));
		if (activeViewName === name) setActiveViewName(null);
	}

	function openSprintEdit() {
		if (!sprintDetail) return;
		setSprintEditName(sprintDetail.name);
		setSprintEditGoal(sprintDetail.goal ?? "");
		setSprintEditStatus(sprintDetail.status);
		setSprintEditStart(sprintDetail.startDate ? tsToDateInput(sprintDetail.startDate) : "");
		setSprintEditEnd(sprintDetail.endDate ? tsToDateInput(sprintDetail.endDate) : "");
		setSprintEditError(null);
		setSprintEditing(true);
	}

	async function saveSprintEdit(e: Event) {
		e.preventDefault();
		if (!sprintDetail) return;
		setSprintEditSaving(true);
		setSprintEditError(null);
		try {
			const body: Record<string, unknown> = { name: sprintEditName.trim() };
			body.goal = sprintEditGoal.trim() || null;
			body.status = sprintEditStatus;
			body.startDate = sprintEditStart
				? Math.floor(new Date(sprintEditStart).getTime() / 1000)
				: null;
			body.endDate = sprintEditEnd ? Math.floor(new Date(sprintEditEnd).getTime() / 1000) : null;
			await apiFetch(`/api/sprints/${sprintDetail.id}`, { method: "PATCH", workspaceSlug, body });
			const updated: SprintDetail = {
				...sprintDetail,
				name: sprintEditName.trim(),
				goal: sprintEditGoal.trim() || null,
				status: sprintEditStatus,
				startDate: sprintEditStart ? Math.floor(new Date(sprintEditStart).getTime() / 1000) : null,
				endDate: sprintEditEnd ? Math.floor(new Date(sprintEditEnd).getTime() / 1000) : null,
			};
			setSprintDetail(updated);
			setSprints((prev) =>
				prev.map((s) =>
					s.id === updated.id ? { ...s, name: updated.name, status: updated.status } : s
				)
			);
			setSprintEditing(false);
		} catch (err) {
			setSprintEditError(String(err));
		} finally {
			setSprintEditSaving(false);
		}
	}

	function applyView(view: SavedView) {
		setFilterStatuses(view.filters.statuses);
		setFilterPriorities(view.filters.priorities);
		setFilterProject(view.filters.project);
		setFilterType(view.filters.type);
		setFilterEpicId(view.filters.epicId);
		setFilterSprintId(view.filters.sprintId);
		setActiveViewName(view.name);
		setShowViewsMenu(false);
	}

	// Derive filter options from loaded issues (fallback when statuses endpoint unavailable)
	const derivedStatuses: TaskStatus[] =
		statuses.length > 0
			? statuses
			: [
					...new Map(
						issues
							.filter((i) => i.status_id)
							.map((i) => [
								// biome-ignore lint/style/noNonNullAssertion: filter above guarantees status_id is set
								i.status_id!,
								{
									// biome-ignore lint/style/noNonNullAssertion: filter above guarantees status_id is set
									id: i.status_id!,
									key: i.status_key ?? "",
									name: i.status_name ?? i.status_key ?? "",
									category: i.status_category ?? "",
									color: null,
								},
							])
					).values(),
				];

	const uniqueProjects = [
		...new Map(
			issues
				.filter((i) => i.project_key)
				.map((i) => [
					// biome-ignore lint/style/noNonNullAssertion: filter above guarantees project_key is set
					i.project_key!,
					{
						// biome-ignore lint/style/noNonNullAssertion: filter above guarantees project_key is set
						key: i.project_key!,
						// biome-ignore lint/style/noNonNullAssertion: filter above guarantees project_key is set
						name: i.project_name ?? i.project_key!,
					},
				])
		).values(),
	];

	const uniqueTypes = [
		...new Map(
			issues
				.filter((i) => i.type_key)
				.map((i) => [
					// biome-ignore lint/style/noNonNullAssertion: filter above guarantees type_key is set
					i.type_key!,
					// biome-ignore lint/style/noNonNullAssertion: filter above guarantees type_key is set
					i.type_name ?? i.type_key!,
				])
		).entries(),
	];

	const epics = issues.filter((i) => i.type_key === "epic");

	const filtered = sortIssues(
		filterIssues(issues, filterStatuses, filterPriorities, filterProject, filterType)
			.filter((i) => !hideEpics || i.type_key !== "epic")
			.filter((i) => {
				if (!filterEpicId) return true;
				if (filterEpicId === "none") return i.parent_id === null && i.type_key !== "epic";
				return i.parent_id === filterEpicId;
			}),
		sortBy,
		sortDir
	);

	// Project description derived from loaded projects
	const projectDescription = filterProject
		? (projects.find((p) => p.key === filterProject)?.description ?? null)
		: null;

	if (loading && !hasLoadedOnce.current) return <p aria-live="polite">Loading issues…</p>;
	if (error)
		return (
			<p role="alert" style={{ color: "var(--danger-text)" }}>
				Failed to load issues: {error}
			</p>
		);

	function handleHeaderClick(key: SortKey) {
		if (sortBy === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortBy(key);
			setSortDir("asc");
		}
	}

	function sortIndicator(key: SortKey) {
		if (sortBy !== key) return null;
		return <span aria-hidden="true">{sortDir === "asc" ? " ↑" : " ↓"}</span>;
	}

	function sortableTh(label: string, key: SortKey, extra?: string) {
		return (
			<th
				class={`text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base${extra ? ` ${extra}` : ""}`}
			>
				<button
					type="button"
					onClick={() => handleHeaderClick(key)}
					class="inline-flex items-center gap-0.5 cursor-pointer bg-transparent border-none p-0 font-semibold text-text-base text-[0.9rem] hover:text-accent"
				>
					{label}
					{sortIndicator(key)}
				</button>
			</th>
		);
	}

	function prioritySelect(issue: Issue) {
		const busy = updatingPriorityId === issue.id;
		const ref = issue.project_key ? `${issue.project_key}-${issue.number}` : issue.number;
		return (
			<Select
				ariaLabel={`Change priority for issue ${ref}`}
				value={issue.priority}
				disabled={busy}
				capitalize
				onChange={(v) => changePriority(issue.id, v)}
				options={PRIORITY_OPTIONS}
				buttonStyle={{
					background: `var(--priority-${issue.priority}-bg, var(--priority-low-bg))`,
					color: `var(--priority-${issue.priority}-text, var(--text-muted))`,
					fontWeight: 500,
					borderColor: "transparent",
				}}
			/>
		);
	}

	function priorityBadge(issue: Issue) {
		return (
			<span
				class="inline-flex items-center px-1.5 py-0.5 rounded text-[0.7rem] font-semibold capitalize whitespace-nowrap"
				style={{
					background: `var(--priority-${issue.priority}-bg, var(--priority-low-bg))`,
					color: `var(--priority-${issue.priority}-text, var(--text-muted))`,
				}}
			>
				{issue.priority === "none" ? "–" : issue.priority}
			</span>
		);
	}

	function statusSelect(issue: Issue) {
		if (statuses.length === 0) return statusBadge(issue);
		const busy = updatingId === issue.id;
		return (
			<Select
				ariaLabel={`Change status for issue ${formatIssueRef(issue.project_key, issue.number)}`}
				value={issue.status_id ?? ""}
				disabled={busy}
				onChange={(v) => changeStatus(issue.id, v)}
				options={statuses.map((s) => ({ value: s.id, label: s.name }))}
				buttonStyle={{
					color: categoryColor(issue.status_category),
					fontWeight: 500,
				}}
			/>
		);
	}

	function statusBadge(issue: Issue) {
		return (
			<span class="font-medium text-sm" style={{ color: categoryColor(issue.status_category) }}>
				{statusDisplayName(issue.status_name, issue.status_key)}
			</span>
		);
	}

	function renderBoard() {
		return (
			<div class="flex gap-4 overflow-x-auto items-start max-sm:flex-col">
				{BOARD_COLUMNS.map((col) => {
					const colIssues = getBoardColumnIssues(filtered, col.category);
					const isOver = dragOverColumn === col.category;
					const dropStatusId = getFirstStatusForCategory(statuses, col.category)?.id;

					return (
						<section
							key={col.category}
							aria-label={`${col.label} column`}
							class="shrink-0 w-[270px] max-sm:w-full"
							onDragOver={(e: DragEvent) => {
								e.preventDefault();
								setDragOverColumn(col.category);
							}}
							onDragLeave={(e: DragEvent) => {
								// Only clear if leaving the column entirely, not entering a child
								if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
									setDragOverColumn(null);
								}
							}}
							onDrop={(e: DragEvent) => {
								e.preventDefault();
								const issueId = e.dataTransfer?.getData("text/plain");
								if (issueId && dropStatusId && window.innerWidth >= 640) {
									changeStatus(issueId, dropStatusId);
								}
								setDragOverColumn(null);
							}}
						>
							{/* Column header */}
							<div class="px-3 py-2 bg-surface rounded-t-md border border-b-0 border-border flex justify-between items-center">
								<span class="font-semibold text-sm" style={{ color: categoryColor(col.category) }}>
									{col.label}
								</span>
								<span class="text-[0.7rem] text-text-muted bg-bg rounded-full px-[0.45rem] py-[0.1rem] font-semibold border border-border">
									{colIssues.length}
								</span>
							</div>

							{/* Cards container */}
							<div
								class="rounded-b-md min-h-24 max-h-[62vh] overflow-y-auto p-2 flex flex-col gap-2 transition-[border-color,background] duration-100"
								style={{
									border: `1px solid ${isOver ? "var(--accent)" : "var(--border)"}`,
									background: isOver ? "rgba(37,99,235,0.04)" : "var(--bg)",
								}}
							>
								{colIssues.length === 0 ? (
									<p class="text-[0.8rem] text-text-muted text-center py-4 m-0">No issues</p>
								) : (
									colIssues.map((issue) => {
										const pts = getStoryPoints(issue);
										return (
											<a
												key={issue.id}
												href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
												class="block bg-surface border border-border rounded-md px-3 py-2.5 no-underline shadow-sm select-none transition-all duration-150 hover:shadow-md hover:border-accent hover:-translate-y-px"
												draggable={true}
												onDragStart={(e: DragEvent) => {
													if (window.innerWidth < 640) {
														e.preventDefault();
														return;
													}
													e.dataTransfer?.setData("text/plain", issue.id);
													setDragIssueId(issue.id);
												}}
												onDragEnd={() => setDragIssueId(null)}
												style={{ opacity: dragIssueId === issue.id ? 0.4 : 1 }}
											>
												<div class="font-mono text-[0.72rem] text-text-muted mb-1">
													{issue.project_key
														? `${issue.project_key}-${issue.number}`
														: `#${issue.number}`}
												</div>
												<div class="text-sm font-medium text-text-base leading-[1.35] mb-2">
													{issue.title}
												</div>
												<div class="flex justify-between items-center gap-2">
													<div class="flex items-center gap-1.5">
														{priorityBadge(issue)}
														{pts && spBadge(pts)}
													</div>
													{issue.assignee_name && (
														<span
															title={issue.assignee_name}
															class="w-6 h-6 rounded-full bg-accent text-white text-[0.68rem] font-bold flex items-center justify-center shrink-0 uppercase"
														>
															{assigneeInitials(issue.assignee_name)}
														</span>
													)}
												</div>
											</a>
										);
									})
								)}
							</div>
						</section>
					);
				})}
			</div>
		);
	}

	function applyBacklogOrder(issues: Issue[]): Issue[] {
		if (backlogOrder.length === 0) return issues;
		const inOrder = backlogOrder.flatMap((id) => {
			const issue = issues.find((i) => i.id === id);
			return issue ? [issue] : [];
		});
		const orderedIds = new Set(backlogOrder);
		const rest = issues.filter((i) => !orderedIds.has(i.id));
		return [...inOrder, ...rest];
	}

	function renderBacklog() {
		const backlogIssues = getBacklogIssues(filtered);

		if (backlogIssues.length === 0) {
			return <p class="text-text-base">No backlog issues match the current filters.</p>;
		}

		const orderedIssues = applyBacklogOrder(backlogIssues);

		function onBacklogDragStart(e: DragEvent, issueId: string) {
			e.dataTransfer?.setData("text/plain", issueId);
			setBacklogDragId(issueId);
		}

		function onBacklogDragOver(e: DragEvent, issueId: string) {
			e.preventDefault();
			setBacklogDragOverId(issueId);
		}

		function onBacklogDrop(e: DragEvent, targetId: string) {
			e.preventDefault();
			const draggedId = e.dataTransfer?.getData("text/plain");
			if (!draggedId || draggedId === targetId) {
				setBacklogDragId(null);
				setBacklogDragOverId(null);
				return;
			}
			const ids = orderedIssues.map((i) => i.id);
			const without = ids.filter((id) => id !== draggedId);
			const targetIdx = without.indexOf(targetId);
			without.splice(targetIdx, 0, draggedId);
			setBacklogOrder(without);
			setBacklogDragId(null);
			setBacklogDragOverId(null);
		}

		function onBacklogDragEnd() {
			setBacklogDragId(null);
			setBacklogDragOverId(null);
		}

		return (
			<>
				<div class="overflow-x-auto max-sm:hidden">
					<table class="w-full border-collapse text-[0.9rem]">
						<thead>
							<tr class="bg-surface">
								<th class="w-8 px-2 py-2 border-b-2 border-border" />
								{sortableTh("#", "number")}
								{sortableTh("Title", "title", "w-full")}
								{sortableTh("Priority", "priority")}
								{sortableTh("Assignee", "assignee")}
								{sortableTh("Status", "status")}
							</tr>
						</thead>
						<tbody
							onDragLeave={(e: DragEvent) => {
								if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
									setBacklogDragOverId(null);
								}
							}}
						>
							{orderedIssues.map((issue) => {
								const pts = getStoryPoints(issue);
								const isDragging = backlogDragId === issue.id;
								const isOver = backlogDragOverId === issue.id && !isDragging;
								return (
									<tr
										key={issue.id}
										class="border-b border-border group"
										draggable={true}
										onDragStart={(e: DragEvent) => onBacklogDragStart(e, issue.id)}
										onDragOver={(e: DragEvent) => onBacklogDragOver(e, issue.id)}
										onDrop={(e: DragEvent) => onBacklogDrop(e, issue.id)}
										onDragEnd={onBacklogDragEnd}
										style={{
											opacity: isDragging ? 0.5 : 1,
											boxShadow: isOver ? "inset 0 2px 0 0 var(--accent)" : undefined,
										}}
									>
										<td class="px-2 py-2 align-middle w-8">
											<span
												class="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity select-none text-base leading-none"
												style={{ cursor: isDragging ? "grabbing" : "grab" }}
												aria-hidden="true"
											>
												⠿
											</span>
										</td>
										<td class="px-3 py-2 align-middle whitespace-nowrap">
											<span class="text-text-muted font-mono text-[0.8rem]">
												{formatIssueRef(issue.project_key, issue.number)}
											</span>
										</td>
										<td class="px-3 py-2 align-middle text-text-base">
											<a
												href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
												class="text-text-base no-underline hover:underline focus:underline"
											>
												{issue.title}
											</a>
										</td>
										<td class="px-3 py-2 align-middle whitespace-nowrap">
											<div class="flex items-center gap-[0.375rem]">
												{prioritySelect(issue)}
												{pts && spBadge(pts)}
											</div>
										</td>
										<td class="px-3 py-2 align-middle whitespace-nowrap text-text-base">
											{issue.assignee_name ?? <span class="text-text-muted">—</span>}
										</td>
										<td class="px-3 py-2 align-middle whitespace-nowrap">{statusSelect(issue)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>

				<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
					{orderedIssues.map((issue) => (
						<div key={issue.id} class="py-3 px-4 border border-border rounded-md bg-surface">
							<div class="font-mono text-[0.8rem] text-text-muted mb-1">
								{formatIssueRef(issue.project_key, issue.number)}
							</div>
							<a
								href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
								class="no-underline"
							>
								<div class="text-[0.9rem] text-text-base font-medium mb-2">{issue.title}</div>
							</a>
							<div class="flex gap-[0.375rem] flex-wrap">
								{prioritySelect(issue)}
								{statusBadge(issue)}
							</div>
						</div>
					))}
				</div>
			</>
		);
	}

	const listCount =
		view === "backlog"
			? filtered.filter((i) => i.status_category === "todo" && i.status_key === "backlog").length
			: filtered.length;

	const isSearchActive = searchQuery.trim().length > 0;

	return (
		<div>
			{/* Project description banner — shown when filtering by a specific project */}
			{filterProject && projectDescription && (
				<p class="mb-4 px-[0.875rem] py-[0.625rem] bg-surface border border-border rounded-md text-sm text-text-muted leading-[1.5]">
					{projectDescription}
				</p>
			)}

			{/* Sprint banner — shown when filtering by a specific sprint */}
			{filterSprintId && sprintDetail && (
				<div class="mb-4 px-[0.875rem] py-[0.625rem] bg-surface border border-border rounded-md">
					{sprintEditing ? (
						<form onSubmit={saveSprintEdit}>
							{sprintEditError && (
								<p role="alert" class="text-[var(--danger-text)] text-sm mb-2">
									{sprintEditError}
								</p>
							)}
							<div class="flex flex-col gap-3">
								<div class="flex gap-3 flex-wrap items-end">
									<div class="flex-1 min-w-[160px]">
										<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
											Name *
											<input
												type="text"
												value={sprintEditName}
												onInput={(e) => setSprintEditName((e.target as HTMLInputElement).value)}
												required
												maxLength={255}
												class="w-full px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base font-normal normal-case tracking-normal mt-[0.2rem]"
											/>
										</label>
									</div>
									<div>
										<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
											Status
											<select
												value={sprintEditStatus}
												onChange={(e) =>
													setSprintEditStatus(
														(e.target as HTMLSelectElement).value as
															| "planned"
															| "active"
															| "completed"
													)
												}
												class="px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base cursor-pointer font-normal normal-case tracking-normal mt-[0.2rem]"
											>
												<option value="planned">Planned</option>
												<option value="active">Active</option>
												<option value="completed">Completed</option>
											</select>
										</label>
									</div>
									<div>
										<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
											Start date
											<input
												type="date"
												value={sprintEditStart}
												onInput={(e) => setSprintEditStart((e.target as HTMLInputElement).value)}
												class="px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base font-normal normal-case tracking-normal mt-[0.2rem]"
											/>
										</label>
									</div>
									<div>
										<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
											End date
											<input
												type="date"
												value={sprintEditEnd}
												onInput={(e) => setSprintEditEnd((e.target as HTMLInputElement).value)}
												class="px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base font-normal normal-case tracking-normal mt-[0.2rem]"
											/>
										</label>
									</div>
								</div>
								<div>
									<label class="block text-[0.72rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
										Goal
										<input
											type="text"
											value={sprintEditGoal}
											onInput={(e) => setSprintEditGoal((e.target as HTMLInputElement).value)}
											maxLength={2000}
											placeholder="What do you want to achieve this sprint?"
											class="w-full px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base font-normal normal-case tracking-normal mt-[0.2rem]"
										/>
									</label>
								</div>
								<div class="flex gap-2">
									<button
										type="submit"
										disabled={sprintEditSaving || !sprintEditName.trim()}
										class="btn btn-primary btn-sm"
									>
										{sprintEditSaving ? "Saving…" : "Save"}
									</button>
									<button
										type="button"
										onClick={() => setSprintEditing(false)}
										class="btn btn-outline btn-sm"
									>
										Cancel
									</button>
								</div>
							</div>
						</form>
					) : (
						<>
							<div class="flex items-center gap-2 flex-wrap">
								<span class="font-semibold text-text-base">{sprintDetail.name}</span>
								<span
									class="text-[0.72rem] font-semibold px-2 py-0.5 rounded-full capitalize border"
									style={{
										background:
											sprintDetail.status === "active"
												? "rgba(37,99,235,0.12)"
												: sprintDetail.status === "completed"
													? "rgba(22,163,74,0.12)"
													: "var(--surface)",
										color:
											sprintDetail.status === "active"
												? "var(--status-in-progress)"
												: sprintDetail.status === "completed"
													? "var(--status-done)"
													: "var(--text-muted)",
										borderColor:
											sprintDetail.status === "active"
												? "rgba(37,99,235,0.3)"
												: sprintDetail.status === "completed"
													? "rgba(22,163,74,0.3)"
													: "var(--border)",
									}}
								>
									{sprintDetail.status}
								</span>
								{sprintDetail.startDate && (
									<span class="text-sm text-text-muted">
										{new Date(sprintDetail.startDate * 1000).toLocaleDateString()}
										{" – "}
										{sprintDetail.endDate
											? new Date(sprintDetail.endDate * 1000).toLocaleDateString()
											: "ongoing"}
									</span>
								)}
								<button
									type="button"
									onClick={openSprintEdit}
									class="py-[0.2rem] px-2 rounded border border-border bg-bg text-text-muted cursor-pointer text-[0.78rem] hover:text-text-base"
								>
									Edit
								</button>
								<button
									type="button"
									onClick={() => setFilterSprintId("")}
									class="ml-auto py-[0.2rem] px-2 rounded border border-border bg-bg text-text-muted cursor-pointer text-[0.78rem]"
								>
									✕ Clear sprint
								</button>
							</div>
							{sprintDetail.goal && (
								<p class="mt-1 text-sm text-text-muted m-0">{sprintDetail.goal}</p>
							)}
							{(() => {
								const doneCount = issues.filter((i) => i.status_category === "done").length;
								const totalCount = issues.length;
								if (totalCount === 0) return null;
								const pct = Math.round((doneCount / totalCount) * 100);
								return (
									<div class="mt-2">
										<div class="flex justify-between text-[0.72rem] text-text-muted mb-1">
											<span>
												{doneCount}/{totalCount} done
											</span>
											<span>{pct}%</span>
										</div>
										<div class="h-1.5 bg-bg rounded-full overflow-hidden border border-border">
											<div
												class="h-full rounded-full transition-[width] duration-300"
												style={{ width: `${pct}%`, background: "var(--accent)" }}
											/>
										</div>
									</div>
								);
							})()}
						</>
					)}
				</div>
			)}

			{updateError && (
				<p role="alert" class="text-[var(--danger-text)] mb-2">
					{updateError}
				</p>
			)}

			{/* Filter + sort toolbar */}
			<div class="flex gap-2 flex-wrap items-center mb-4 p-3 bg-surface rounded-lg border border-border shadow-[var(--shadow-sm)]">
				{/* Search input (PROJ-110) */}
				<div class="flex items-center gap-1">
					<input
						ref={searchInputRef}
						type="search"
						value={searchQuery}
						onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
						placeholder="Search…"
						aria-label="Search issues"
						class="py-1 px-[0.625rem] border border-border rounded bg-bg text-text-base text-[0.8rem] outline-none"
						style={{ width: isSearchActive ? "12rem" : "7rem", transition: "width 0.2s" }}
					/>
					{isSearchActive && (
						<button
							type="button"
							aria-label="Clear search"
							onClick={() => {
								setSearchQuery("");
								searchInputRef.current?.focus();
							}}
							class="bg-transparent border-none text-text-muted cursor-pointer text-base px-1 leading-none"
						>
							×
						</button>
					)}
				</div>

				{/* Filters button + popover (status & priority) */}
				{(() => {
					const activeFilterCount = filterStatuses.length + filterPriorities.length;
					const PILL_COLORS: Record<string, { bg: string; text: string }> = {
						urgent: { bg: "#dc2626", text: "#fff" },
						high: { bg: "#d97706", text: "#fff" },
						medium: { bg: "#2563eb", text: "#fff" },
						low: { bg: "#6b7280", text: "#fff" },
					};
					return (
						<div class="relative" ref={filtersContainerRef}>
							<button
								ref={filtersButtonRef}
								type="button"
								disabled={isSearchActive}
								onClick={() => {
									if (showFiltersPopover) {
										setShowFiltersPopover(false);
									} else {
										const rect = filtersButtonRef.current?.getBoundingClientRect();
										if (rect) filtersPopoverPos.current = { top: rect.bottom + 4, left: rect.left };
										setShowFiltersPopover(true);
									}
								}}
								style={{
									padding: "0.25rem 0.625rem",
									borderRadius: "9999px",
									border: activeFilterCount > 0 ? "none" : "1px solid var(--border)",
									background: activeFilterCount > 0 ? "var(--accent)" : "var(--bg)",
									color: activeFilterCount > 0 ? "#fff" : "var(--text)",
									cursor: isSearchActive ? "default" : "pointer",
									fontSize: "0.8rem",
									fontWeight: activeFilterCount > 0 ? 600 : 400,
									opacity: isSearchActive ? 0.4 : 1,
									transition: "opacity 0.15s",
								}}
							>
								{activeFilterCount > 0 ? `Filters (${activeFilterCount})` : "Filters"}
							</button>
							{showFiltersPopover && (
								<div
									ref={filtersPopoverRef}
									style={{
										position: "fixed",
										top: `${filtersPopoverPos.current.top}px`,
										left: `${filtersPopoverPos.current.left}px`,
										zIndex: 100,
										background: "var(--surface)",
										border: "1px solid var(--border)",
										borderRadius: "0.5rem",
										padding: "0.75rem",
										boxShadow: "var(--shadow-sm)",
										minWidth: "16rem",
									}}
								>
									<div class="text-[0.7rem] font-semibold text-text-muted uppercase tracking-[0.04em] mb-2">
										Status
									</div>
									<div class="flex flex-wrap gap-1 mb-3">
										{derivedStatuses.map((s) => {
											const active = filterStatuses.includes(s.id);
											return (
												<button
													type="button"
													key={s.id}
													aria-pressed={active}
													onClick={() =>
														setFilterStatuses((prev) =>
															active ? prev.filter((id) => id !== s.id) : [...prev, s.id]
														)
													}
													style={{
														padding: "0.25rem 0.625rem",
														borderRadius: "9999px",
														border: active ? "none" : "1px solid var(--border)",
														background: active ? categoryColor(s.category) : "var(--bg)",
														color: active ? "#fff" : "var(--text)",
														cursor: "pointer",
														fontSize: "0.8rem",
														fontWeight: active ? 600 : 400,
													}}
												>
													{s.name}
												</button>
											);
										})}
									</div>
									<div class="text-[0.7rem] font-semibold text-text-muted uppercase tracking-[0.04em] mb-2">
										Priority
									</div>
									<div class="flex flex-wrap gap-1">
										{(["urgent", "high", "medium", "low"] as const).map((p) => {
											const active = filterPriorities.includes(p);
											const col = PILL_COLORS[p];
											return (
												<button
													type="button"
													key={p}
													aria-pressed={active}
													onClick={() =>
														setFilterPriorities((prev) =>
															active ? prev.filter((k) => k !== p) : [...prev, p]
														)
													}
													style={{
														padding: "0.25rem 0.625rem",
														borderRadius: "9999px",
														border: active ? "none" : "1px solid var(--border)",
														background: active ? col.bg : "var(--bg)",
														color: active ? col.text : "var(--text)",
														cursor: "pointer",
														fontSize: "0.8rem",
														fontWeight: active ? 600 : 400,
														textTransform: "capitalize" as const,
													}}
												>
													{p}
												</button>
											);
										})}
									</div>
									{activeFilterCount > 0 && (
										<div class="border-t border-border pt-2 mt-3">
											<button
												type="button"
												onClick={() => {
													setFilterStatuses([]);
													setFilterPriorities([]);
												}}
												class="bg-transparent border-none text-text-muted cursor-pointer text-[0.8rem] p-0"
											>
												✕ Clear all
											</button>
										</div>
									)}
								</div>
							)}
						</div>
					);
				})()}

				{uniqueProjects.length > 0 && (
					<Select
						ariaLabel="Filter by project"
						value={filterProject}
						onChange={(v) => {
							setFilterProject(v);
							setFilterSprintId("");
						}}
						options={[
							{ value: "", label: "All projects" },
							...uniqueProjects.map((p) => ({ value: p.key, label: p.name })),
						]}
					/>
				)}

				{sprints.length > 0 && (
					<Select
						ariaLabel="Filter by sprint"
						value={filterSprintId}
						onChange={setFilterSprintId}
						options={[
							{ value: "", label: "All sprints" },
							...sprints.map((s) => ({
								value: s.id,
								label: `${s.status === "active" ? "● " : ""}${s.name}`,
							})),
						]}
					/>
				)}

				{uniqueTypes.length > 0 && (
					<Select
						ariaLabel="Filter by type"
						value={filterType}
						onChange={setFilterType}
						options={[
							{ value: "", label: "All types" },
							...uniqueTypes.map(([key, name]) => ({ value: key, label: name })),
						]}
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

				{/* Saved views dropdown (PROJ-141) */}
				{savedViews.length > 0 && (
					<div class="relative" ref={viewsContainerRef}>
						<button
							ref={viewsButtonRef}
							type="button"
							class="select-button"
							aria-haspopup="listbox"
							aria-expanded={showViewsMenu}
							aria-label="Saved views"
							onClick={() => {
								if (showViewsMenu) {
									setShowViewsMenu(false);
								} else {
									const rect = viewsButtonRef.current?.getBoundingClientRect();
									if (rect)
										viewsMenuPos.current = {
											top: rect.bottom + 4,
											left: rect.left,
											width: rect.width,
										};
									setShowViewsMenu(true);
								}
							}}
						>
							<span>{activeViewName ?? "Views"}</span>
							<span class="select-caret" aria-hidden="true">
								▾
							</span>
						</button>
						{showViewsMenu && (
							<ul
								ref={viewsMenuRef}
								class="select-menu"
								aria-label="Saved views"
								style={{
									position: "fixed",
									top: `${viewsMenuPos.current.top}px`,
									left: `${viewsMenuPos.current.left}px`,
									minWidth: `${viewsMenuPos.current.width}px`,
								}}
							>
								{savedViews.map((v) => (
									<li
										key={v.name}
										class="select-option"
										data-selected={v.name === activeViewName || undefined}
										style={{
											display: "flex",
											justifyContent: "space-between",
											alignItems: "center",
											gap: "0.5rem",
										}}
									>
										<button
											type="button"
											style={{
												flexGrow: 1,
												cursor: "pointer",
												background: "none",
												border: "none",
												padding: 0,
												textAlign: "left",
												font: "inherit",
												color: "inherit",
											}}
											onClick={() => applyView(v)}
										>
											{v.name}
										</button>
										<button
											type="button"
											aria-label={`Delete view ${v.name}`}
											onClick={(e: MouseEvent) => {
												e.stopPropagation();
												deleteView(v.name);
											}}
											style={{
												background: "none",
												border: "none",
												cursor: "pointer",
												color: "var(--text-muted)",
												padding: "0 0.2rem",
												fontSize: "0.85rem",
												lineHeight: "1",
												flexShrink: 0,
											}}
										>
											×
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				)}

				{/* Save view button / inline input (PROJ-141) */}
				{showSaveInput ? (
					<div class="flex items-center gap-1">
						<input
							type="text"
							value={saveViewName}
							onInput={(e) => setSaveViewName((e.target as HTMLInputElement).value)}
							onKeyDown={(e: KeyboardEvent) => {
								if (e.key === "Enter") doSaveView();
								if (e.key === "Escape") {
									setSaveViewName("");
									setShowSaveInput(false);
								}
							}}
							placeholder="View name…"
							// biome-ignore lint/a11y/noAutofocus: intentional — triggered by user action
							autoFocus
							class="py-1 px-[0.625rem] border border-border rounded bg-bg text-text-base text-[0.8rem] outline-none"
							style={{ width: "8rem" }}
						/>
						<button
							type="button"
							onClick={doSaveView}
							class="py-1 px-[0.625rem] rounded border border-border bg-bg text-text-base text-[0.8rem] cursor-pointer"
						>
							Save
						</button>
						<button
							type="button"
							aria-label="Cancel save view"
							onClick={() => {
								setSaveViewName("");
								setShowSaveInput(false);
							}}
							class="bg-transparent border-none text-text-muted cursor-pointer text-base px-1 leading-none"
						>
							×
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setShowSaveInput(true)}
						class="py-1 px-[0.625rem] rounded-full border border-border bg-bg text-text-muted cursor-pointer text-[0.8rem]"
					>
						Save view
					</button>
				)}

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
			</div>

			{/* Count row + view toggle + New issue button */}
			<div class="flex justify-between items-center mb-3">
				<p class="text-sm text-text-muted m-0">
					{isSearchActive && searchResults !== null
						? `${searchResults.length} result${searchResults.length !== 1 ? "s" : ""} for «${searchQuery.trim()}»`
						: `${listCount} issue${listCount !== 1 ? "s" : ""}${view !== "backlog" && issues.length !== filtered.length ? ` (of ${issues.length})` : ""}`}
				</p>

				<div class="flex gap-2 items-center">
					{/* New issue button (PROJ-62) */}
					{projects.length > 0 && (
						<button type="button" onClick={openCreateModal} class="btn btn-primary btn-sm">
							+ New issue
						</button>
					)}

					{/* View toggle — hidden when searching */}
					{!isSearchActive && (
						<fieldset
							aria-label="View mode"
							class="flex border border-border rounded-md overflow-hidden m-0 p-0"
						>
							<legend class="hidden">View mode</legend>
							{(["list", "board", "backlog"] as const).map((v) => (
								<button
									type="button"
									key={v}
									aria-pressed={view === v}
									onClick={() => setView(v)}
									style={{
										padding: "0.25rem 0.75rem",
										border: "none",
										borderRight: v !== "backlog" ? "1px solid var(--border)" : "none",
										background: view === v ? "var(--accent)" : "var(--bg)",
										color: view === v ? "#fff" : "var(--text-muted)",
										cursor: "pointer",
										fontSize: "0.8rem",
										fontWeight: view === v ? 600 : 400,
										textTransform: "capitalize" as const,
										transition: "background 0.1s, color 0.1s",
									}}
								>
									{v}
								</button>
							))}
						</fieldset>
					)}
				</div>
			</div>

			{/* Main content */}
			{isSearchActive ? (
				// Search results view (PROJ-110)
				searchLoading ? (
					<p aria-live="polite" class="text-text-muted">
						Searching…
					</p>
				) : searchResults === null ? null : searchResults.length === 0 ? (
					<p class="text-text-muted">No results for «{searchQuery.trim()}»</p>
				) : (
					<div class="overflow-x-auto max-sm:hidden">
						<table class="w-full border-collapse text-[0.9rem]">
							<thead>
								<tr class="bg-surface">
									<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
										#
									</th>
									<th class="text-left px-3 py-2 border-b-2 border-border font-semibold w-full text-text-base">
										Title
									</th>
									<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
										Priority
									</th>
									<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
										Status
									</th>
								</tr>
							</thead>
							<tbody>
								{searchResults.map((r) => (
									<tr key={r.id} class="border-b border-border">
										<td class="px-3 py-2 align-middle whitespace-nowrap">
											<span class="text-text-muted font-mono text-[0.8rem]">
												{r.project_key ? `${r.project_key}-${r.number}` : `#${r.number}`}
											</span>
										</td>
										<td class="px-3 py-2 align-middle text-text-base">
											<a
												href={issueUrl(r.project_key, r.number, r.title, r.id)}
												class="text-text-base no-underline hover:underline focus:underline"
											>
												{r.title}
											</a>
										</td>
										<td class="px-3 py-2 align-middle whitespace-nowrap">
											<span
												class="inline-flex items-center px-1.5 py-0.5 rounded text-[0.7rem] font-semibold capitalize whitespace-nowrap"
												style={{
													background: `var(--priority-${r.priority}-bg, var(--priority-low-bg))`,
													color: `var(--priority-${r.priority}-text, var(--text-muted))`,
												}}
											>
												{r.priority === "none" ? "–" : r.priority}
											</span>
										</td>
										<td class="px-3 py-2 align-middle whitespace-nowrap">
											<span class="font-medium text-sm text-text-muted">
												{r.status.replace(/_/g, " ")}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)
			) : view === "board" ? (
				renderBoard()
			) : view === "backlog" ? (
				renderBacklog()
			) : filtered.length === 0 ? (
				<p class="text-text-base">No issues match the current filters.</p>
			) : (
				<>
					{/* Desktop table */}
					<div class="overflow-x-auto max-sm:hidden">
						<table class="w-full border-collapse text-[0.9rem]">
							<thead>
								<tr class="bg-surface">
									{sortableTh("#", "number")}
									{sortableTh("Title", "title", "w-full")}
									{sortableTh("Priority", "priority")}
									{sortableTh("Assignee", "assignee")}
									{sortableTh("Status", "status")}
								</tr>
							</thead>
							<tbody>
								{filtered.map((issue) => {
									const pts = getStoryPoints(issue);
									return (
										<tr key={issue.id} class="border-b border-border">
											<td class="px-3 py-2 align-middle whitespace-nowrap">
												<span class="text-text-muted font-mono text-[0.8rem]">
													{formatIssueRef(issue.project_key, issue.number)}
												</span>
											</td>
											<td class="px-3 py-2 align-middle text-text-base">
												<a
													href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
													class="text-text-base no-underline hover:underline focus:underline"
												>
													{issue.title}
												</a>
											</td>
											<td class="px-3 py-2 align-middle whitespace-nowrap">
												<div class="flex items-center gap-[0.375rem]">
													{prioritySelect(issue)}
													{pts && spBadge(pts)}
												</div>
											</td>
											<td class="px-3 py-2 align-middle whitespace-nowrap text-text-base">
												{issue.assignee_name ?? <span class="text-text-muted">—</span>}
											</td>
											<td class="px-3 py-2 align-middle whitespace-nowrap">
												{statusSelect(issue)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Mobile cards */}
					<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
						{filtered.map((issue) => (
							<div key={issue.id} class="py-3 px-4 border border-border rounded-md bg-surface">
								<div class="font-mono text-[0.8rem] text-text-muted mb-1">
									{formatIssueRef(issue.project_key, issue.number)}
								</div>
								<a
									href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
									class="no-underline"
								>
									<div class="text-[0.9rem] text-text-base font-medium mb-2">{issue.title}</div>
								</a>
								<div class="flex gap-[0.375rem] flex-wrap">
									{prioritySelect(issue)}
									{statusBadge(issue)}
								</div>
							</div>
						))}
					</div>
				</>
			)}

			{/* Create issue modal (PROJ-62) */}
			{showCreateModal && (
				<div
					class="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
					onClick={(e) => {
						if (e.target === e.currentTarget) setShowCreateModal(false);
					}}
				>
					<div
						class="bg-bg border border-border rounded-lg p-6 w-full max-w-[660px] max-h-[80vh] overflow-y-auto mx-4 max-sm:rounded-t-lg max-sm:rounded-b-none max-sm:max-h-[90vh] max-sm:mx-0"
						role="dialog"
						aria-modal="true"
						aria-label="Create new issue"
					>
						<h2 class="mb-5 text-lg font-bold text-text-base">New issue</h2>

						{createError && (
							<p role="alert" class="text-[var(--danger-text)] mb-3 text-sm">
								{createError}
							</p>
						)}

						<form onSubmit={submitCreate}>
							{/* Title */}
							<div class="mb-[0.875rem]">
								<label class="block text-[0.78rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
									Title *
									<input
										type="text"
										value={createTitle}
										onInput={(e) => setCreateTitle((e.target as HTMLInputElement).value)}
										placeholder="Issue title"
										required
										// biome-ignore lint/a11y/noAutofocus: intentional — modal opens on user action
										autoFocus
										class="w-full px-3 py-2 border border-border rounded bg-bg text-text-base box-border text-[0.9rem] font-normal normal-case tracking-normal mt-[0.3rem]"
									/>
								</label>
							</div>

							{/* Body (MarkdownEditor) */}
							<div class="mb-[0.875rem]">
								<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
									Description
									<MarkdownEditor value={createBody} onChange={setCreateBody} minHeight="160px" />
								</label>
							</div>

							{/* Project / Priority / Status row */}
							<div class="flex gap-3 mb-5 flex-wrap items-end">
								{projects.length > 1 && (
									<div>
										<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
											Project
											<Select
												ariaLabel="Select project"
												value={createProjectId}
												onChange={setCreateProjectId}
												options={projects.map((p) => ({ value: p.id, label: p.name }))}
											/>
										</label>
									</div>
								)}

								<div>
									<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
										Priority
										<Select
											ariaLabel="Select priority"
											value={createPriority}
											onChange={setCreatePriority}
											capitalize
											options={PRIORITY_OPTIONS}
											buttonStyle={{
												background: `var(--priority-${createPriority}-bg, var(--priority-low-bg))`,
												color: `var(--priority-${createPriority}-text, var(--text-muted))`,
												fontWeight: 500,
												borderColor: "transparent",
											}}
										/>
									</label>
								</div>

								{taskTypes.length > 0 && (
									<div>
										<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
											Type
											<Select
												ariaLabel="Select type"
												value={createTypeId}
												onChange={setCreateTypeId}
												options={[
													{ value: "", label: "No type" },
													...taskTypes.map((t) => ({ value: t.id, label: t.name })),
												]}
											/>
										</label>
									</div>
								)}

								{statuses.length > 0 && (
									<div>
										<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
											Status
											<Select
												ariaLabel="Select status"
												value={createStatusId}
												onChange={setCreateStatusId}
												options={[
													{ value: "", label: "Default" },
													...statuses.map((s) => ({ value: s.id, label: s.name })),
												]}
											/>
										</label>
									</div>
								)}
							</div>

							<div class="flex gap-2">
								<button
									type="submit"
									disabled={submittingCreate || !createTitle.trim() || !createProjectId}
									class="btn btn-primary"
								>
									{submittingCreate ? "Creating…" : "Create issue"}
								</button>
								<button
									type="button"
									onClick={() => setShowCreateModal(false)}
									class="btn btn-outline"
								>
									Cancel
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
