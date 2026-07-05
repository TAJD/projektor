import type { Dispatch, MutableRef, StateUpdater } from "preact/hooks";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { statusDisplayName } from "../lib/status";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import { PRIORITY_OPTIONS } from "../utils/issue-utils";
import {
	CATEGORY_COLORS,
	categoryColor,
	type Issue,
	type SortKey,
	sortIssues,
} from "./board-utils";
import Select from "./Select";

interface Props {
	workspaceSlug?: string;
}

interface ProjectMeta {
	id: string;
	key: string;
	name: string;
}

type EpicRollup = { done: number; remaining: number; total: number };
type DerivedStatus = { id: string; name: string; category: string };

const PRIORITY_LABEL: Record<string, string> = {
	urgent: "Urgent",
	high: "High",
	medium: "Medium",
	low: "Low",
	none: "None",
};

const PILL_COLORS: Record<string, { bg: string; text: string }> = {
	urgent: { bg: "#dc2626", text: "#fff" },
	high: { bg: "#d97706", text: "#fff" },
	medium: { bg: "#2563eb", text: "#fff" },
	low: { bg: "#6b7280", text: "#fff" },
};

const TH_CLASS =
	"text-left px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-[0.05em] border-b-2 border-border";
const CELL_CLASS =
	"px-3 py-[0.625rem] border-b border-border align-middle group-hover:bg-surface [tr:last-child_&]:border-b-0";
const MODAL_CLASS =
	"bg-bg border border-border rounded-lg p-6 w-full max-w-[480px] mx-4 " +
	"max-sm:rounded-t-lg max-sm:rounded-b-none max-sm:mx-0";

function parseUrlFilters(params: URLSearchParams): { statuses: string[]; priorities: string[] } {
	const s = params.get("status");
	const p = params.get("priority");
	return {
		statuses: s ? s.split(",").filter(Boolean) : [],
		priorities: p ? p.split(",").filter(Boolean) : [],
	};
}

function persistResolvedProjectId(resolved: string) {
	// safe-ls: resolved id is either the stored value (just confirmed to
	// exist in the fetched project list) or the first project — never a
	// stale reference, so it can't cause an API 4xx.
	localStorage.setItem("projektor-last-project-id", resolved);
	const p = new URLSearchParams(window.location.search);
	p.set("projectId", resolved);
	history.replaceState(null, "", `?${p.toString()}`);
}

function resolveProjectId(
	prev: string | null,
	stored: string | null,
	projects: ProjectMeta[]
): string | null {
	if (prev) return prev;
	const validated = stored && projects.some((p) => p.id === stored) ? stored : null;
	return validated ?? projects[0]?.id ?? null;
}

async function fetchEpicRollups(
	epicItems: Issue[],
	workspaceSlug: string | undefined
): Promise<Record<string, EpicRollup>> {
	const results = await Promise.all(
		epicItems.map((ep) =>
			apiFetch<{ rollup?: EpicRollup }>(`/api/issues/${ep.id}`, { workspaceSlug })
				.then((detail) => (detail.rollup ? { id: ep.id, rollup: detail.rollup } : null))
				.catch(() => null)
		)
	);
	const rollups: Record<string, EpicRollup> = {};
	for (const r of results) {
		if (r) rollups[r.id] = r.rollup;
	}
	return rollups;
}

function defaultCreateProjectId(projectId: string | null, projects: ProjectMeta[]): string {
	if (projectId) return projects.find((p) => p.id === projectId)?.id ?? projects[0]?.id ?? "";
	return projects[0]?.id ?? "";
}

function computeFilteredEpics(
	epics: Issue[],
	filterStatuses: string[],
	filterPriorities: string[]
): Issue[] {
	return epics.filter((ep) => {
		if (filterStatuses.length > 0 && (!ep.status_id || !filterStatuses.includes(ep.status_id)))
			return false;
		if (filterPriorities.length > 0 && !filterPriorities.includes(ep.priority)) return false;
		return true;
	});
}

function computeDerivedStatuses(epics: Issue[]): DerivedStatus[] {
	const derived: DerivedStatus[] = [];
	const seen = new Set<string>();
	for (const ep of epics) {
		if (ep.status_id && !seen.has(ep.status_id)) {
			seen.add(ep.status_id);
			derived.push({
				id: ep.status_id,
				name: ep.status_name ?? ep.status_key ?? ep.status_id,
				category: ep.status_category ?? "",
			});
		}
	}
	return derived;
}

function sortIndicator(key: SortKey, sortBy: SortKey, sortDir: "asc" | "desc") {
	if (sortBy !== key) return null;
	return <span class="ml-1 opacity-60">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

function EpicListHeader(props: FiltersPopoverProps & { epicTypeId: string | null; onOpenCreate: () => void }) {
	return (
		<div class="flex items-center justify-between mb-4 gap-2 flex-wrap">
			<FiltersPopover {...props} />
			{props.epicTypeId && (
				<button type="button" onClick={props.onOpenCreate} class="btn btn-primary btn-sm">
					+ New Epic
				</button>
			)}
		</div>
	);
}

function useEpicFilters() {
	const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
	const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
	const [showFiltersPopover, setShowFiltersPopover] = useState(false);

	const filtersContainerRef = useRef<HTMLDivElement>(null);
	const filtersPopoverRef = useRef<HTMLDivElement>(null);
	const filtersButtonRef = useRef<HTMLButtonElement>(null);
	const filtersPopoverPos = useRef({ top: 0, left: 0 });

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const { statuses, priorities } = parseUrlFilters(params);
		if (statuses.length > 0) setFilterStatuses(statuses);
		if (priorities.length > 0) setFilterPriorities(priorities);
	}, []);

	// Sync filter state to URL without page reload
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
		history.replaceState(null, "", `?${params.toString()}`);
	}, [filterStatuses, filterPriorities]);

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

	return {
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		showFiltersPopover,
		setShowFiltersPopover,
		filtersContainerRef,
		filtersPopoverRef,
		filtersButtonRef,
		filtersPopoverPos,
		activeFilterCount: filterStatuses.length + filterPriorities.length,
	};
}

function useProjectSelection(workspaceSlug: string | undefined) {
	const [projectId, setProjectId] = useState<string | null>(null);
	const [projectIdReady, setProjectIdReady] = useState(false);
	const [epicTypeId, setEpicTypeId] = useState<string | null>(null);
	const [projects, setProjects] = useState<ProjectMeta[]>([]);
	const storedProjectIdRef = useRef<string | null>(null);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		// Resolve projectId: URL param (trusted) → localStorage (validated against the
		// fetched project list in the projects effect below) → defer to projects fetch.
		const fromUrl = params.get("projectId");
		if (fromUrl) {
			setProjectId(fromUrl);
			// safe-ls: remembers the last-viewed project id so a future visit without a
			// URL param can skip re-selection. Never trusted directly — the projects
			// effect below validates it against the fetched project list and falls back
			// to the first project if it's missing (e.g. the project was deleted).
			localStorage.setItem("projektor-last-project-id", fromUrl);
			setProjectIdReady(true);
		} else {
			storedProjectIdRef.current = localStorage.getItem("projektor-last-project-id");
			// projects fetch effect validates the stored id (if any) and marks ready
		}
	}, []);

	// Fetch epic task type ID
	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<Array<{ id: string; key: string; name: string }>>(
					"/api/task-types",
					{ workspaceSlug }
				);
				if (Array.isArray(data)) {
					const epic = data.find((t) => t.key === "epic");
					if (epic) setEpicTypeId(epic.id);
				}
			} catch {
				// non-fatal
			}
		})();
	}, [workspaceSlug]);

	// Fetch projects for create form; also provides API fallback when no projectId in URL/localStorage
	useEffect(() => {
		(async () => {
			try {
				const data = await apiFetch<ProjectMeta[]>("/api/projects", { workspaceSlug });
				if (Array.isArray(data)) {
					setProjects(data);
					setProjectId((prev) => {
						const resolved = resolveProjectId(prev, storedProjectIdRef.current, data);
						if (resolved) persistResolvedProjectId(resolved);
						return resolved;
					});
				}
			} catch {
				// non-fatal
			} finally {
				setProjectIdReady(true);
			}
		})();
	}, [workspaceSlug]);

	return { projectId, projectIdReady, epicTypeId, projects };
}

function useEpicsData(
	projectId: string | null,
	projectIdReady: boolean,
	epicTypeId: string | null,
	workspaceSlug: string | undefined
) {
	const [epics, setEpics] = useState<Issue[]>([]);
	const [epicRollups, setEpicRollups] = useState<Record<string, EpicRollup>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchEpics = useCallback(async () => {
		if (!projectId) {
			setLoading(false);
			return;
		}
		if (!epicTypeId) return; // stay loading while task-types resolves
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<{ items: Issue[] }>(
				`/api/issues?project=${encodeURIComponent(projectId)}&typeId=${encodeURIComponent(epicTypeId)}&limit=100`,
				{ workspaceSlug }
			);
			const epicItems = data.items ?? [];
			setEpics(epicItems);
			setEpicRollups({});

			if (epicItems.length > 0) {
				fetchEpicRollups(epicItems, workspaceSlug).then(setEpicRollups);
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, epicTypeId, workspaceSlug]);

	useEffect(() => {
		if (projectIdReady) fetchEpics();
	}, [fetchEpics, projectIdReady]);

	return { epics, epicRollups, loading, error, fetchEpics };
}

function useCreateEpicForm(
	workspaceSlug: string | undefined,
	projectId: string | null,
	projects: ProjectMeta[],
	epicTypeId: string | null,
	fetchEpics: () => Promise<void>
) {
	const [showCreate, setShowCreate] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createProjectId, setCreateProjectId] = useState("");
	const [createPriority, setCreatePriority] = useState("medium");
	const [submitting, setSubmitting] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	function openCreate() {
		setCreateProjectId(defaultCreateProjectId(projectId, projects));
		setCreateTitle("");
		setCreatePriority("medium");
		setCreateError(null);
		setShowCreate(true);
	}

	async function submitCreate(e: Event) {
		e.preventDefault();
		if (!createTitle.trim() || !createProjectId || !epicTypeId) return;
		setSubmitting(true);
		setCreateError(null);
		try {
			await apiFetch("/api/issues", {
				method: "POST",
				workspaceSlug,
				body: {
					projectId: createProjectId,
					title: createTitle.trim(),
					priority: createPriority,
					typeId: epicTypeId,
				},
			});
			setShowCreate(false);
			await fetchEpics();
		} catch (e) {
			setCreateError(`Failed to create epic: ${String(e)}`);
		} finally {
			setSubmitting(false);
		}
	}

	return {
		showCreate,
		setShowCreate,
		createTitle,
		setCreateTitle,
		createProjectId,
		setCreateProjectId,
		createPriority,
		setCreatePriority,
		submitting,
		createError,
		openCreate,
		submitCreate,
	};
}

export default function EpicList({ workspaceSlug }: Props) {
	const {
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		showFiltersPopover,
		setShowFiltersPopover,
		filtersContainerRef,
		filtersPopoverRef,
		filtersButtonRef,
		filtersPopoverPos,
		activeFilterCount,
	} = useEpicFilters();

	const { projectId, projectIdReady, epicTypeId, projects } = useProjectSelection(workspaceSlug);

	const [sortBy, setSortBy] = useState<SortKey>("created_at");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	const { epics, epicRollups, loading, error, fetchEpics } = useEpicsData(
		projectId,
		projectIdReady,
		epicTypeId,
		workspaceSlug
	);

	const {
		showCreate,
		setShowCreate,
		createTitle,
		setCreateTitle,
		createProjectId,
		setCreateProjectId,
		createPriority,
		setCreatePriority,
		submitting,
		createError,
		openCreate,
		submitCreate,
	} = useCreateEpicForm(workspaceSlug, projectId, projects, epicTypeId, fetchEpics);

	function toggleSort(key: SortKey) {
		if (sortBy === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortBy(key);
			setSortDir("asc");
		}
	}

	const filteredEpics = computeFilteredEpics(epics, filterStatuses, filterPriorities);
	const derivedStatuses = computeDerivedStatuses(epics);

	if (!projectIdReady || loading) return <p aria-live="polite">Loading…</p>;
	if (error)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);

	return (
		<div>
			<EpicListHeader
				filtersContainerRef={filtersContainerRef}
				filtersPopoverRef={filtersPopoverRef}
				filtersButtonRef={filtersButtonRef}
				filtersPopoverPos={filtersPopoverPos}
				showFiltersPopover={showFiltersPopover}
				setShowFiltersPopover={setShowFiltersPopover}
				activeFilterCount={activeFilterCount}
				derivedStatuses={derivedStatuses}
				filterStatuses={filterStatuses}
				setFilterStatuses={setFilterStatuses}
				filterPriorities={filterPriorities}
				setFilterPriorities={setFilterPriorities}
				epicTypeId={epicTypeId}
				onOpenCreate={openCreate}
			/>

			<EpicsTable
				epics={epics}
				filteredEpics={filteredEpics}
				epicRollups={epicRollups}
				sortBy={sortBy}
				sortDir={sortDir}
				toggleSort={toggleSort}
			/>

			<CreateEpicModal
				showCreate={showCreate}
				setShowCreate={setShowCreate}
				createTitle={createTitle}
				setCreateTitle={setCreateTitle}
				createProjectId={createProjectId}
				setCreateProjectId={setCreateProjectId}
				createPriority={createPriority}
				setCreatePriority={setCreatePriority}
				submitting={submitting}
				createError={createError}
				projects={projects}
				submitCreate={submitCreate}
			/>
		</div>
	);
}

interface FiltersPopoverProps {
	filtersContainerRef: MutableRef<HTMLDivElement | null>;
	filtersPopoverRef: MutableRef<HTMLDivElement | null>;
	filtersButtonRef: MutableRef<HTMLButtonElement | null>;
	filtersPopoverPos: MutableRef<{ top: number; left: number }>;
	showFiltersPopover: boolean;
	setShowFiltersPopover: (v: boolean) => void;
	activeFilterCount: number;
	derivedStatuses: DerivedStatus[];
	filterStatuses: string[];
	setFilterStatuses: Dispatch<StateUpdater<string[]>>;
	filterPriorities: string[];
	setFilterPriorities: Dispatch<StateUpdater<string[]>>;
}

function StatusFilterPills({
	derivedStatuses,
	filterStatuses,
	setFilterStatuses,
}: {
	derivedStatuses: DerivedStatus[];
	filterStatuses: string[];
	setFilterStatuses: Dispatch<StateUpdater<string[]>>;
}) {
	if (derivedStatuses.length === 0) {
		return <span class="text-[0.78rem] text-text-muted">No epics loaded</span>;
	}
	return (
		<>
			{derivedStatuses.map((s) => {
				const active = filterStatuses.includes(s.id);
				return (
					<button
						type="button"
						key={s.id}
						aria-pressed={active}
						onClick={() =>
							setFilterStatuses((prev) => (active ? prev.filter((id) => id !== s.id) : [...prev, s.id]))
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
		</>
	);
}

function PriorityFilterPills({
	filterPriorities,
	setFilterPriorities,
}: {
	filterPriorities: string[];
	setFilterPriorities: Dispatch<StateUpdater<string[]>>;
}) {
	return (
		<>
			{(["urgent", "high", "medium", "low"] as const).map((pr) => {
				const active = filterPriorities.includes(pr);
				const col = PILL_COLORS[pr];
				return (
					<button
						type="button"
						key={pr}
						aria-pressed={active}
						onClick={() =>
							setFilterPriorities((prev) => (active ? prev.filter((k) => k !== pr) : [...prev, pr]))
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
						{pr}
					</button>
				);
			})}
		</>
	);
}

function FiltersPopover({
	filtersContainerRef,
	filtersPopoverRef,
	filtersButtonRef,
	filtersPopoverPos,
	showFiltersPopover,
	setShowFiltersPopover,
	activeFilterCount,
	derivedStatuses,
	filterStatuses,
	setFilterStatuses,
	filterPriorities,
	setFilterPriorities,
}: FiltersPopoverProps) {
	return (
		<div class="relative" ref={filtersContainerRef}>
			<button
				ref={filtersButtonRef}
				type="button"
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
					cursor: "pointer",
					fontSize: "0.8rem",
					fontWeight: activeFilterCount > 0 ? 600 : 400,
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
						<StatusFilterPills
							derivedStatuses={derivedStatuses}
							filterStatuses={filterStatuses}
							setFilterStatuses={setFilterStatuses}
						/>
					</div>
					<div class="text-[0.7rem] font-semibold text-text-muted uppercase tracking-[0.04em] mb-2">
						Priority
					</div>
					<div class="flex flex-wrap gap-1">
						<PriorityFilterPills
							filterPriorities={filterPriorities}
							setFilterPriorities={setFilterPriorities}
						/>
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
}

interface EpicsTableProps {
	epics: Issue[];
	filteredEpics: Issue[];
	epicRollups: Record<string, EpicRollup>;
	sortBy: SortKey;
	sortDir: "asc" | "desc";
	toggleSort: (key: SortKey) => void;
}

function EpicsTable({
	epics,
	filteredEpics,
	epicRollups,
	sortBy,
	sortDir,
	toggleSort,
}: EpicsTableProps) {
	if (epics.length === 0) {
		return (
			<p class="text-text-muted text-sm">No epics found. Use the button above to create one.</p>
		);
	}
	if (filteredEpics.length === 0) {
		return <p class="text-text-muted text-sm">No epics match the active filters.</p>;
	}
	return (
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm" aria-label="Epics">
				<thead>
					<tr>
						<th class={TH_CLASS}>Title</th>
						<th class={TH_CLASS}>Status</th>
						<th
							class={`${TH_CLASS} cursor-pointer select-none hover:text-text-base`}
							onClick={() => toggleSort("priority")}
						>
							Priority{sortIndicator("priority", sortBy, sortDir)}
						</th>
						<th class={TH_CLASS}>Children</th>
					</tr>
				</thead>
				<tbody>
					{sortIssues(filteredEpics, sortBy, sortDir).map((ep) => (
						<EpicRow key={ep.id} ep={ep} rollup={epicRollups[ep.id]} />
					))}
				</tbody>
			</table>
		</div>
	);
}

interface EpicRowProps {
	ep: Issue;
	rollup: EpicRollup | undefined;
}

function EpicRow({ ep, rollup }: EpicRowProps) {
	const statusColor = CATEGORY_COLORS[ep.status_category ?? ""] ?? "var(--text-muted)";
	return (
		<tr class="group">
			<td class={CELL_CLASS}>
				<a
					href={issueUrl(ep.project_key, ep.number, ep.title, ep.id)}
					class="text-text-base no-underline font-medium hover:underline"
				>
					{ep.title}
				</a>
			</td>
			<td class={CELL_CLASS}>
				<span class="font-medium text-[0.8rem]" style={{ color: statusColor }}>
					{statusDisplayName(ep.status_name, ep.status_key)}
				</span>
			</td>
			<td class={CELL_CLASS}>
				<span class="inline-flex items-center px-[0.45rem] py-[0.1rem] rounded-[3px] text-xs font-medium">
					{PRIORITY_LABEL[ep.priority] ?? ep.priority}
				</span>
			</td>
			<td class={CELL_CLASS}>
				{!rollup || rollup.total === 0 ? (
					<span class="font-mono text-xs text-text-muted">—</span>
				) : (
					<span class="text-xs text-text-muted">
						{rollup.done} done · {rollup.remaining} remaining
					</span>
				)}
			</td>
		</tr>
	);
}

interface CreateEpicModalProps {
	showCreate: boolean;
	setShowCreate: (v: boolean) => void;
	createTitle: string;
	setCreateTitle: (v: string) => void;
	createProjectId: string;
	setCreateProjectId: (v: string) => void;
	createPriority: string;
	setCreatePriority: (v: string) => void;
	submitting: boolean;
	createError: string | null;
	projects: ProjectMeta[];
	submitCreate: (e: Event) => void;
}

function CreateEpicModal({
	showCreate,
	setShowCreate,
	createTitle,
	setCreateTitle,
	createProjectId,
	setCreateProjectId,
	createPriority,
	setCreatePriority,
	submitting,
	createError,
	projects,
	submitCreate,
}: CreateEpicModalProps) {
	if (!showCreate) return null;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes on click; Escape on the dialog covers keyboard
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop closes on click; Escape on the dialog covers keyboard
		<div
			class="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
			onClick={(e) => {
				if (e.target === e.currentTarget) setShowCreate(false);
			}}
		>
			<div class={MODAL_CLASS} role="dialog" aria-modal="true" aria-label="Create new epic">
				<h2 class="mb-5 text-lg font-bold text-text-base">New Epic</h2>

				{createError && (
					<p role="alert" class="text-[var(--danger-text)] mb-3 text-sm">
						{createError}
					</p>
				)}

				<form onSubmit={submitCreate}>
					<div class="mb-[0.875rem]">
						<label
							htmlFor="create-epic-title"
							class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
						>
							Title *
						</label>
						<input
							id="create-epic-title"
							type="text"
							value={createTitle}
							onInput={(e) => setCreateTitle((e.target as HTMLInputElement).value)}
							placeholder="Epic title"
							required
							// biome-ignore lint/a11y/noAutofocus: intentional — modal opens on user action
							autoFocus
							class="w-full px-3 py-2 border border-border rounded bg-bg text-text-base box-border text-[0.9rem]"
						/>
					</div>

					<div class="flex gap-3 mb-5 flex-wrap items-end">
						{projects.length > 1 && (
							<div>
								{/* biome-ignore lint/a11y/noLabelWithoutControl: Select uses ariaLabel for accessibility */}
								<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
									Project
								</label>
								<Select
									ariaLabel="Select project"
									value={createProjectId}
									onChange={setCreateProjectId}
									options={projects.map((p) => ({ value: p.id, label: p.name }))}
								/>
							</div>
						)}

						<div>
							{/* biome-ignore lint/a11y/noLabelWithoutControl: Select uses ariaLabel for accessibility */}
							<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]">
								Priority
							</label>
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
						</div>
					</div>

					<div class="flex gap-2">
						<button
							type="submit"
							disabled={submitting || !createTitle.trim() || !createProjectId}
							class="btn btn-primary"
						>
							{submitting ? "Creating…" : "Create Epic"}
						</button>
						<button type="button" onClick={() => setShowCreate(false)} class="btn btn-outline">
							Cancel
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
