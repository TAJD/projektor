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

const PRIORITY_LABEL: Record<string, string> = {
	urgent: "Urgent",
	high: "High",
	medium: "Medium",
	low: "Low",
	none: "None",
};

export default function EpicList({ workspaceSlug }: Props) {
	const [projectId, setProjectId] = useState<string | null>(null);
	const [projectIdReady, setProjectIdReady] = useState(false);

	const [epics, setEpics] = useState<Issue[]>([]);
	const [epicRollups, setEpicRollups] = useState<
		Record<string, { done: number; remaining: number; total: number }>
	>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const [epicTypeId, setEpicTypeId] = useState<string | null>(null);
	const [projects, setProjects] = useState<ProjectMeta[]>([]);

	const [sortBy, setSortBy] = useState<SortKey>("created_at");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
	const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
	const [showFiltersPopover, setShowFiltersPopover] = useState(false);

	const filtersContainerRef = useRef<HTMLDivElement>(null);
	const filtersPopoverRef = useRef<HTMLDivElement>(null);
	const filtersButtonRef = useRef<HTMLButtonElement>(null);
	const filtersPopoverPos = useRef({ top: 0, left: 0 });

	// Create modal state
	const [showCreate, setShowCreate] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createProjectId, setCreateProjectId] = useState("");
	const [createPriority, setCreatePriority] = useState("medium");
	const [submitting, setSubmitting] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);

		// Read filters from URL
		const s = params.get("status");
		const p = params.get("priority");
		if (s) setFilterStatuses(s.split(",").filter(Boolean));
		if (p) setFilterPriorities(p.split(",").filter(Boolean));

		// Resolve projectId: URL param → localStorage → defer to projects fetch
		const fromUrl = params.get("projectId");
		if (fromUrl) {
			setProjectId(fromUrl);
			localStorage.setItem("projektor-last-project-id", fromUrl);
			setProjectIdReady(true);
		} else {
			const stored = localStorage.getItem("projektor-last-project-id");
			if (stored) {
				setProjectId(stored);
				const newParams = new URLSearchParams(window.location.search);
				newParams.set("projectId", stored);
				history.replaceState(null, "", `?${newParams.toString()}`);
				setProjectIdReady(true);
			}
			// else: projects fetch effect will set projectId and mark ready
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
						if (prev) return prev;
						const first = data[0]?.id ?? null;
						if (first) {
							localStorage.setItem("projektor-last-project-id", first);
							const p = new URLSearchParams(window.location.search);
							p.set("projectId", first);
							history.replaceState(null, "", `?${p.toString()}`);
						}
						return first;
					});
				}
			} catch {
				// non-fatal
			} finally {
				setProjectIdReady(true);
			}
		})();
	}, [workspaceSlug]);

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

			// Fetch rollup for each epic in parallel
			if (epicItems.length > 0) {
				Promise.all(
					epicItems.map((ep) =>
						apiFetch<{ rollup?: { done: number; remaining: number; total: number } }>(
							`/api/issues/${ep.id}`,
							{ workspaceSlug }
						)
							.then((detail) => (detail.rollup ? { id: ep.id, rollup: detail.rollup } : null))
							.catch(() => null)
					)
				).then((results) => {
					const rollups: Record<string, { done: number; remaining: number; total: number }> = {};
					for (const r of results) {
						if (r) rollups[r.id] = r.rollup;
					}
					setEpicRollups(rollups);
				});
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

	function openCreate() {
		const defaultProjectId = projectId
			? (projects.find((p) => p.id === projectId)?.id ?? projects[0]?.id ?? "")
			: (projects[0]?.id ?? "");
		setCreateProjectId(defaultProjectId);
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

	function toggleSort(key: SortKey) {
		if (sortBy === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortBy(key);
			setSortDir("asc");
		}
	}

	function sortIndicator(key: SortKey) {
		if (sortBy !== key) return null;
		return <span class="ml-1 opacity-60">{sortDir === "asc" ? "↑" : "↓"}</span>;
	}

	const filteredEpics = epics.filter((ep) => {
		if (filterStatuses.length > 0 && (!ep.status_id || !filterStatuses.includes(ep.status_id)))
			return false;
		if (filterPriorities.length > 0 && !filterPriorities.includes(ep.priority)) return false;
		return true;
	});

	// Derive unique statuses from fetched epics for the filter popover
	const derivedStatuses: { id: string; name: string; category: string }[] = [];
	{
		const seen = new Set<string>();
		for (const ep of epics) {
			if (ep.status_id && !seen.has(ep.status_id)) {
				seen.add(ep.status_id);
				derivedStatuses.push({
					id: ep.status_id,
					name: ep.status_name ?? ep.status_key ?? ep.status_id,
					category: ep.status_category ?? "",
				});
			}
		}
	}

	const activeFilterCount = filterStatuses.length + filterPriorities.length;

	const PILL_COLORS: Record<string, { bg: string; text: string }> = {
		urgent: { bg: "#dc2626", text: "#fff" },
		high: { bg: "#d97706", text: "#fff" },
		medium: { bg: "#2563eb", text: "#fff" },
		low: { bg: "#6b7280", text: "#fff" },
	};

	if (!projectIdReady || loading) return <p aria-live="polite">Loading…</p>;
	if (error)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);

	return (
		<div>
			<div class="flex items-center justify-between mb-4 gap-2 flex-wrap">
				{/* Filters button + popover */}
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
								{derivedStatuses.length === 0 ? (
									<span class="text-[0.78rem] text-text-muted">No epics loaded</span>
								) : (
									derivedStatuses.map((s) => {
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
									})
								)}
							</div>
							<div class="text-[0.7rem] font-semibold text-text-muted uppercase tracking-[0.04em] mb-2">
								Priority
							</div>
							<div class="flex flex-wrap gap-1">
								{(["urgent", "high", "medium", "low"] as const).map((pr) => {
									const active = filterPriorities.includes(pr);
									const col = PILL_COLORS[pr];
									return (
										<button
											type="button"
											key={pr}
											aria-pressed={active}
											onClick={() =>
												setFilterPriorities((prev) =>
													active ? prev.filter((k) => k !== pr) : [...prev, pr]
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
											{pr}
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

				{epicTypeId && (
					<button type="button" onClick={openCreate} class="btn btn-primary btn-sm">
						+ New Epic
					</button>
				)}
			</div>

			{epics.length === 0 ? (
				<p class="text-text-muted text-sm">No epics found. Use the button above to create one.</p>
			) : filteredEpics.length === 0 ? (
				<p class="text-text-muted text-sm">No epics match the active filters.</p>
			) : (
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-sm" aria-label="Epics">
						<thead>
							<tr>
								<th class="text-left px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-[0.05em] border-b-2 border-border">
									Title
								</th>
								<th class="text-left px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-[0.05em] border-b-2 border-border">
									Status
								</th>
								<th
									class="text-left px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-[0.05em] border-b-2 border-border cursor-pointer select-none hover:text-text-base"
									onClick={() => toggleSort("priority")}
								>
									Priority{sortIndicator("priority")}
								</th>
								<th class="text-left px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-[0.05em] border-b-2 border-border">
									Children
								</th>
							</tr>
						</thead>
						<tbody>
							{sortIssues(filteredEpics, sortBy, sortDir).map((ep) => {
								const statusColor =
									CATEGORY_COLORS[ep.status_category ?? ""] ?? "var(--text-muted)";
								return (
									<tr key={ep.id} class="group">
										<td class="px-3 py-[0.625rem] border-b border-border align-middle group-hover:bg-surface [tr:last-child_&]:border-b-0">
											<a
												href={issueUrl(ep.project_key, ep.number, ep.title, ep.id)}
												class="text-text-base no-underline font-medium hover:underline"
											>
												{ep.title}
											</a>
										</td>
										<td class="px-3 py-[0.625rem] border-b border-border align-middle group-hover:bg-surface [tr:last-child_&]:border-b-0">
											<span class="font-medium text-[0.8rem]" style={{ color: statusColor }}>
												{statusDisplayName(ep.status_name, ep.status_key)}
											</span>
										</td>
										<td class="px-3 py-[0.625rem] border-b border-border align-middle group-hover:bg-surface [tr:last-child_&]:border-b-0">
											<span class="inline-flex items-center px-[0.45rem] py-[0.1rem] rounded-[3px] text-xs font-medium">
												{PRIORITY_LABEL[ep.priority] ?? ep.priority}
											</span>
										</td>
										<td class="px-3 py-[0.625rem] border-b border-border align-middle group-hover:bg-surface [tr:last-child_&]:border-b-0">
											{(() => {
												const r = epicRollups[ep.id];
												if (!r || r.total === 0)
													return <span class="font-mono text-xs text-text-muted">—</span>;
												return (
													<span class="text-xs text-text-muted">
														{r.done} done · {r.remaining} remaining
													</span>
												);
											})()}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{/* Create Epic modal */}
			{showCreate && (
				// biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes modal on click; keyboard users close via Escape on the dialog
				// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop closes modal on click; keyboard users close via Escape on the dialog
				<div
					class="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
					onClick={(e) => {
						if (e.target === e.currentTarget) setShowCreate(false);
					}}
				>
					<div
						class="bg-bg border border-border rounded-lg p-6 w-full max-w-[480px] mx-4 max-sm:rounded-t-lg max-sm:rounded-b-none max-sm:mx-0"
						role="dialog"
						aria-modal="true"
						aria-label="Create new epic"
					>
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
			)}
		</div>
	);
}
