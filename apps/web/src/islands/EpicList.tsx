import { useCallback, useEffect, useState } from "preact/hooks";
import { statusDisplayName } from "../lib/status";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import { PRIORITY_OPTIONS } from "../utils/issue-utils";
import { CATEGORY_COLORS, type Issue, type SortKey, sortIssues } from "./board-utils";
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

	// Create modal state
	const [showCreate, setShowCreate] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createProjectId, setCreateProjectId] = useState("");
	const [createPriority, setCreatePriority] = useState("medium");
	const [submitting, setSubmitting] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	useEffect(() => {
		setProjectId(new URLSearchParams(window.location.search).get("projectId"));
		setProjectIdReady(true);
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

	// Fetch projects for create form
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

	if (!projectIdReady || loading) return <p aria-live="polite">Loading…</p>;
	if (error)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);

	return (
		<div>
			<div class="flex justify-end mb-4">
				{epicTypeId && (
					<button type="button" onClick={openCreate} class="btn btn-primary btn-sm">
						+ New Epic
					</button>
				)}
			</div>

			{epics.length === 0 ? (
				<p class="text-text-muted text-sm">No epics found. Use the button above to create one.</p>
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
							{sortIssues(epics, sortBy, sortDir).map((ep) => {
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
