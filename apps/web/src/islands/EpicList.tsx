import { useCallback, useEffect, useState } from "preact/hooks";
import { statusDisplayName } from "../lib/status";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import { PRIORITY_OPTIONS } from "../utils/issue-utils";
import { resolveProjectId } from "../utils/resolve-project-id";
import {
	CATEGORY_COLORS,
	type Issue,
	type ProjectLookup as ProjectMeta,
	type SortKey,
	sortIssues,
	type TaskStatus,
} from "./board-utils";
import { applyDateRangeParams } from "./IssueList-helpers";
import type { DateField } from "./issue-list/FiltersPopover";
import FiltersPopover from "./issue-list/FiltersPopover";
import { Button } from "./ui/Button";
import Select from "./ui/Select";

interface Props {
	workspaceSlug?: string;
}

type EpicRollup = { done: number; remaining: number; total: number };

// PROJ-441: rollup is attached server-side per item when includeRollups=1 is passed —
// see the /api/issues fetch in useEpicsData below.
type EpicItem = Issue & { rollup?: EpicRollup };

const PRIORITY_LABEL: Record<string, string> = {
	urgent: "Urgent",
	high: "High",
	medium: "Medium",
	low: "Low",
	none: "None",
};

const TH_CLASS =
	"text-left px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-[0.05em] border-b-2 border-border";
const CELL_CLASS =
	"px-3 py-[0.625rem] border-b border-border align-middle group-hover:bg-surface [tr:last-child_&]:border-b-0";
// CD-294: the panel had no max-height and no scroll region, so inside the
// `fixed inset-0` backdrop (bottom-anchored on phones) anything taller than the
// visual viewport overflowed off the top with no way to scroll to it — the Title
// field first. `dvh`, not `vh`: iOS never shrinks `vh` for the keyboard or an
// expanded URL bar, which is exactly when this panel runs out of room.
const MODAL_CLASS =
	"bg-bg border border-border rounded-lg p-6 w-full max-w-[480px] mx-4 " +
	"max-h-[80dvh] overflow-y-auto overscroll-contain " +
	"max-sm:rounded-t-lg max-sm:rounded-b-none max-sm:mx-0 max-sm:max-h-[90dvh]";

function parseDateField(v: string | null): DateField {
	return v === "completed" || v === "updated" ? v : "";
}

function parseUrlFilters(params: URLSearchParams): {
	statuses: string[];
	priorities: string[];
	dateField: DateField;
	dateFrom: string;
	dateTo: string;
} {
	const s = params.get("status");
	const p = params.get("priority");
	return {
		statuses: s ? s.split(",").filter(Boolean) : [],
		priorities: p ? p.split(",").filter(Boolean) : [],
		dateField: parseDateField(params.get("dateField")),
		dateFrom: params.get("dateFrom") ?? "",
		dateTo: params.get("dateTo") ?? "",
	};
}

function defaultCreateProjectId(
	projectId: string | null,
	projects: readonly ProjectMeta[]
): string {
	if (projectId) return projects.find((p) => p.id === projectId)?.id ?? projects[0]?.id ?? "";
	return projects[0]?.id ?? "";
}

function computeFilteredEpics(
	epics: readonly Issue[],
	filterStatuses: readonly string[],
	filterPriorities: readonly string[]
): Issue[] {
	return epics.filter((ep) => {
		if (filterStatuses.length > 0 && (!ep.status_id || !filterStatuses.includes(ep.status_id)))
			return false;
		if (filterPriorities.length > 0 && !filterPriorities.includes(ep.priority)) return false;
		return true;
	});
}

function computeDerivedStatuses(epics: readonly Issue[]): TaskStatus[] {
	const derived: TaskStatus[] = [];
	const seen = new Set<string>();
	for (const ep of epics) {
		if (ep.status_id && !seen.has(ep.status_id)) {
			seen.add(ep.status_id);
			derived.push({
				id: ep.status_id,
				key: ep.status_key ?? ep.status_id,
				name: ep.status_name ?? ep.status_key ?? ep.status_id,
				category: ep.status_category ?? "",
				color: null,
			});
		}
	}
	return derived;
}

function sortIndicator(key: SortKey, sortBy: SortKey, sortDir: "asc" | "desc") {
	if (sortBy !== key) return null;
	return <span class="ml-1 opacity-60">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

interface EpicListHeaderProps {
	derivedStatuses: TaskStatus[];
	filterStatuses: string[];
	setFilterStatuses: (v: string[] | ((prev: string[]) => string[])) => void;
	filterPriorities: string[];
	setFilterPriorities: (v: string[] | ((prev: string[]) => string[])) => void;
	filterDateField: DateField;
	setFilterDateField: (v: DateField | ((prev: DateField) => DateField)) => void;
	filterDateFrom: string;
	setFilterDateFrom: (v: string | ((prev: string) => string)) => void;
	filterDateTo: string;
	setFilterDateTo: (v: string | ((prev: string) => string)) => void;
	epicTypeId: string | null;
	onOpenCreate: () => void;
}

function EpicListHeader(props: EpicListHeaderProps) {
	return (
		<div class="flex items-center justify-between mb-4 gap-2 flex-wrap">
			<FiltersPopover
				derivedStatuses={props.derivedStatuses}
				filterStatuses={props.filterStatuses}
				setFilterStatuses={props.setFilterStatuses}
				filterPriorities={props.filterPriorities}
				setFilterPriorities={props.setFilterPriorities}
				filterDateField={props.filterDateField}
				setFilterDateField={props.setFilterDateField}
				filterDateFrom={props.filterDateFrom}
				setFilterDateFrom={props.setFilterDateFrom}
				filterDateTo={props.filterDateTo}
				setFilterDateTo={props.setFilterDateTo}
				isSearchActive={false}
			/>
			{props.epicTypeId && (
				<Button variant="primary" size="sm" onClick={props.onOpenCreate}>
					+ New Epic
				</Button>
			)}
		</div>
	);
}

function useEpicFilters() {
	const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
	const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
	const [filterDateField, setFilterDateField] = useState<DateField>("");
	const [filterDateFrom, setFilterDateFrom] = useState("");
	const [filterDateTo, setFilterDateTo] = useState("");

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const { statuses, priorities, dateField, dateFrom, dateTo } = parseUrlFilters(params);
		if (statuses.length > 0) setFilterStatuses(statuses);
		if (priorities.length > 0) setFilterPriorities(priorities);
		if (dateField) setFilterDateField(dateField);
		if (dateFrom) setFilterDateFrom(dateFrom);
		if (dateTo) setFilterDateTo(dateTo);
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
		if (filterDateField) {
			params.set("dateField", filterDateField);
		} else {
			params.delete("dateField");
		}
		if (filterDateFrom) {
			params.set("dateFrom", filterDateFrom);
		} else {
			params.delete("dateFrom");
		}
		if (filterDateTo) {
			params.set("dateTo", filterDateTo);
		} else {
			params.delete("dateTo");
		}
		history.replaceState(null, "", `?${params.toString()}`);
	}, [filterStatuses, filterPriorities, filterDateField, filterDateFrom, filterDateTo]);

	return {
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
	};
}

function useProjectSelection(workspaceSlug: string | undefined) {
	const [projectId, setProjectId] = useState<string | null>(null);
	const [projectIdReady, setProjectIdReady] = useState(false);
	const [projectError, setProjectError] = useState<string | null>(null);
	const [epicTypeId, setEpicTypeId] = useState<string | null>(null);
	const [projects, setProjects] = useState<ProjectMeta[]>([]);

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

	useEffect(() => {
		let cancelled = false;
		resolveProjectId<ProjectMeta>(workspaceSlug).then((res) => {
			if (cancelled) return;
			setProjects(res.projects);
			setProjectId(res.project?.id ?? null);
			setProjectError(res.error);
			setProjectIdReady(true);
		});
		return () => {
			cancelled = true;
		};
	}, [workspaceSlug]);

	return { projectId, projectIdReady, projectError, epicTypeId, projects };
}

interface UseEpicsDataOptions {
	projectId: string | null;
	projectIdReady: boolean;
	epicTypeId: string | null;
	workspaceSlug: string | undefined;
	filterDateField: DateField;
	filterDateFrom: string;
	filterDateTo: string;
}

function useEpicsData({
	projectId,
	projectIdReady,
	epicTypeId,
	workspaceSlug,
	filterDateField,
	filterDateFrom,
	filterDateTo,
}: UseEpicsDataOptions) {
	const [epics, setEpics] = useState<EpicItem[]>([]);
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
			const qs = new URLSearchParams({
				project: projectId,
				typeId: epicTypeId,
				limit: "100",
				// PROJ-441: child rollups computed server-side in one grouped query,
				// attached per item — replaces the old per-epic getIssue fan-out.
				includeRollups: "1",
			});
			applyDateRangeParams(qs, filterDateField, filterDateFrom, filterDateTo);
			const data = await apiFetch<{ items: EpicItem[] }>(`/api/issues?${qs}`, { workspaceSlug });
			setEpics(data.items ?? []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, epicTypeId, workspaceSlug, filterDateField, filterDateFrom, filterDateTo]);

	useEffect(() => {
		if (projectIdReady) fetchEpics();
	}, [fetchEpics, projectIdReady]);

	return { epics, loading, error, fetchEpics };
}

function useCreateEpicForm(
	workspaceSlug: string | undefined,
	projectId: string | null,
	projects: readonly ProjectMeta[],
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
		filterDateField,
		setFilterDateField,
		filterDateFrom,
		setFilterDateFrom,
		filterDateTo,
		setFilterDateTo,
	} = useEpicFilters();

	const { projectId, projectIdReady, projectError, epicTypeId, projects } =
		useProjectSelection(workspaceSlug);

	const [sortBy, setSortBy] = useState<SortKey>("created_at");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	const { epics, loading, error, fetchEpics } = useEpicsData({
		projectId,
		projectIdReady,
		epicTypeId,
		workspaceSlug,
		filterDateField,
		filterDateFrom,
		filterDateTo,
	});

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
	if (error || projectError)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error || projectError}
			</p>
		);

	return (
		<div>
			<EpicListHeader
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
				epicTypeId={epicTypeId}
				onOpenCreate={openCreate}
			/>

			<EpicsTable
				epics={epics}
				filteredEpics={filteredEpics}
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

interface EpicsTableProps {
	epics: EpicItem[];
	filteredEpics: EpicItem[];
	sortBy: SortKey;
	sortDir: "asc" | "desc";
	toggleSort: (key: SortKey) => void;
}

function EpicsTable({ epics, filteredEpics, sortBy, sortDir, toggleSort }: EpicsTableProps) {
	if (epics.length === 0) {
		return (
			<p class="text-text-muted text-sm">No epics found. Use the button above to create one.</p>
		);
	}
	if (filteredEpics.length === 0) {
		return <p class="text-text-muted text-sm">No epics match the active filters.</p>;
	}
	// sortIssues' signature is Issue[] => Issue[]; the sort is a pure reorder, so the
	// rollup field carried by EpicItem survives — safe to cast back.
	const sorted = sortIssues(filteredEpics, sortBy, sortDir) as EpicItem[];
	return (
		<>
			<div class="overflow-x-auto max-sm:hidden">
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
						{sorted.map((ep) => (
							<EpicRow key={ep.id} ep={ep} rollup={ep.rollup} />
						))}
					</tbody>
				</table>
			</div>
			<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
				{sorted.map((ep) => (
					<EpicMobileCard key={ep.id} ep={ep} rollup={ep.rollup} />
				))}
			</div>
		</>
	);
}

function EpicMobileCard({ ep, rollup }: EpicRowProps) {
	const statusColor = CATEGORY_COLORS[ep.status_category ?? ""] ?? "var(--text-muted)";
	return (
		<div class="py-3 px-4 border border-border rounded-md bg-surface">
			<a
				href={issueUrl(ep.project_key, ep.number, ep.title, ep.id)}
				class="text-text-base no-underline font-medium hover:underline"
			>
				{ep.title}
			</a>
			<div class="flex justify-between items-center gap-2 mt-1">
				<span class="font-medium text-[0.8rem]" style={{ color: statusColor }}>
					{statusDisplayName(ep.status_name, ep.status_key)}
				</span>
				<span class="text-xs font-medium">{PRIORITY_LABEL[ep.priority] ?? ep.priority}</span>
			</div>
			<div class="text-xs text-text-muted mt-1">
				{!rollup || rollup.total === 0
					? "—"
					: `${rollup.done} done · ${rollup.remaining} remaining`}
			</div>
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
			// CD-294: above the topbar (z-index: 110), below popovers (200).
			class="fixed inset-0 z-[120] flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
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
						<Button
							type="submit"
							variant="primary"
							disabled={submitting || !createTitle.trim() || !createProjectId}
						>
							{submitting ? "Creating…" : "Create Epic"}
						</Button>
						<Button variant="outline" onClick={() => setShowCreate(false)}>
							Cancel
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
