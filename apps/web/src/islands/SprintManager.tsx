import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch, buildHeaders } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";

interface Sprint {
	id: string;
	name: string;
	goal: string | null;
	status: "planned" | "active" | "completed";
	startDate: string | null;
	endDate: string | null;
	projectId: string;
	createdAt: number;
}

interface Project {
	id: string;
	name: string;
	key: string;
}

interface CustomFieldValue {
	key: string;
	label: string;
	type: string;
	value: string;
}

interface Issue {
	id: string;
	title: string;
	number: number;
	status_category: string | null;
	project_key: string | null;
	customFields: CustomFieldValue[];
}

interface CompletionSummary {
	sprint: Sprint;
	issues: Issue[];
}

interface SprintVelocity {
	sprint: Sprint;
	pointsCompleted: number;
	pointsTotal: number;
}

interface Props {
	workspaceSlug?: string;
}

function getStoryPoints(issue: Issue): number {
	const cf = issue.customFields?.find((f) => f.key === "story_points");
	if (!cf) return 0;
	const n = parseFloat(cf.value);
	return Number.isNaN(n) ? 0 : n;
}

function statusBadge(status: Sprint["status"]) {
	const styles: Record<Sprint["status"], { bg: string; color: string }> = {
		planned: { bg: "var(--surface)", color: "var(--text-muted)" },
		active: { bg: "rgba(37,99,235,0.12)", color: "var(--status-in-progress)" },
		completed: { bg: "rgba(22,163,74,0.12)", color: "var(--status-done)" },
	};
	const s = styles[status] ?? styles.planned;
	return (
		<span
			class="badge border border-current font-semibold capitalize"
			style={{ background: s.bg, color: s.color }}
		>
			{status}
		</span>
	);
}

function formatDate(d: string | null): string {
	if (!d) return "—";
	return new Date(d).toLocaleDateString();
}

function CompletionSummaryPanel({
	summary,
	onClose,
}: {
	summary: CompletionSummary;
	onClose: () => void;
}) {
	const { sprint, issues } = summary;
	const doneIssues = issues.filter((i) => i.status_category === "done");
	const totalSP = issues.reduce((sum, i) => sum + getStoryPoints(i), 0);
	const doneSP = doneIssues.reduce((sum, i) => sum + getStoryPoints(i), 0);

	return (
		<div class="mb-6 px-5 py-4 bg-[rgba(22,163,74,0.06)] border border-[rgba(22,163,74,0.3)] rounded-lg">
			<div class="flex justify-between items-start mb-3">
				<h3 class="m-0 text-base font-semibold text-text-base">
					Sprint complete: {sprint.name}
				</h3>
				<button
					type="button"
					class="text-sm text-text-muted hover:text-text-base"
					onClick={onClose}
				>
					Close
				</button>
			</div>
			{(sprint.startDate || sprint.endDate) && (
				<p class="text-sm text-text-muted m-0 mb-3">
					{formatDate(sprint.startDate)} – {formatDate(sprint.endDate)}
				</p>
			)}
			<div class="flex gap-6 mb-4 text-sm flex-wrap">
				<div>
					<span class="text-text-muted">Issues:</span>{" "}
					<strong class="text-text-base">
						{doneIssues.length}/{issues.length}
					</strong>
				</div>
				{totalSP > 0 && (
					<div>
						<span class="text-text-muted">Story points:</span>{" "}
						<strong class="text-text-base">{doneSP}/{totalSP}</strong>
					</div>
				)}
			</div>
			{doneIssues.length > 0 && (
				<div>
					<p class="m-0 mb-2 text-[0.78rem] font-semibold text-text-muted uppercase tracking-[0.04em]">
						Completed issues
					</p>
					<ul class="m-0 p-0 list-none flex flex-col gap-1">
						{doneIssues.map((issue) => (
							<li key={issue.id}>
								<a
									href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
									class="text-sm text-[var(--accent)] no-underline hover:underline"
								>
									{issue.title}
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

const BAR_AREA_PX = 100;

function VelocityChart({
	data,
	loading,
}: {
	data: SprintVelocity[];
	loading: boolean;
}) {
	const maxPts = Math.max(...data.map((d) => d.pointsTotal), 1);

	return (
		<div class="mt-8 p-5 bg-surface border border-border rounded-lg">
			<h2 class="m-0 mb-4 text-base font-semibold text-text-base">Velocity</h2>
			{loading ? (
				<p class="text-sm text-text-muted m-0">Loading velocity…</p>
			) : data.length === 0 ? (
				<p class="text-sm text-text-muted m-0">No completed sprints yet</p>
			) : (
				<div>
					<div class="flex items-end gap-2" style={{ height: `${BAR_AREA_PX + 48}px` }}>
						{data.map(({ sprint, pointsCompleted, pointsTotal }) => {
							const totalH = Math.round((pointsTotal / maxPts) * BAR_AREA_PX);
							const doneH =
								totalH > 0
									? Math.round((pointsCompleted / pointsTotal) * totalH)
									: 0;
							return (
								<div
									key={sprint.id}
									class="flex-1 flex flex-col items-center justify-end min-w-0"
									style={{ height: `${BAR_AREA_PX + 48}px` }}
								>
									<div class="text-[0.7rem] font-semibold text-text-base mb-1">
										{pointsCompleted}
										{pointsTotal > 0 && pointsCompleted !== pointsTotal && (
											<span class="font-normal text-text-muted">
												/{pointsTotal}
											</span>
										)}
									</div>
									<div
										class="relative w-full rounded-t"
										style={{
											height: `${Math.max(totalH, 2)}px`,
											background: "rgba(37,99,235,0.15)",
										}}
									>
										{doneH > 0 && (
											<div
												class="absolute bottom-0 left-0 right-0 rounded-t"
												style={{
													height: `${doneH}px`,
													background: "var(--status-done)",
													opacity: "0.8",
												}}
											/>
										)}
									</div>
									<div class="mt-1 text-[0.65rem] text-text-muted truncate w-full text-center leading-tight px-1">
										{sprint.name}
									</div>
								</div>
							);
						})}
					</div>
					<div class="mt-3 flex gap-4 text-xs text-text-muted">
						<span class="inline-flex items-center gap-1">
							<span
								class="inline-block w-3 h-2 rounded-sm"
								style={{ background: "var(--status-done)", opacity: "0.8" }}
							/>
							Completed SP
						</span>
						<span class="inline-flex items-center gap-1">
							<span
								class="inline-block w-3 h-2 rounded-sm"
								style={{ background: "rgba(37,99,235,0.15)" }}
							/>
							Total SP
						</span>
					</div>
				</div>
			)}
		</div>
	);
}

export default function SprintManager({ workspaceSlug }: Props) {
	const [projectId, setProjectId] = useState<string | null>(null);
	const [project, setProject] = useState<Project | null>(null);
	const [sprints, setSprints] = useState<Sprint[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Create form
	const [showCreate, setShowCreate] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createGoal, setCreateGoal] = useState("");
	const [createStart, setCreateStart] = useState("");
	const [createEnd, setCreateEnd] = useState("");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	// Complete confirm
	const [completeId, setCompleteId] = useState<string | null>(null);
	const [completing, setCompleting] = useState(false);
	const [completeError, setCompleteError] = useState<string | null>(null);

	// Completion summary
	const [completionSummary, setCompletionSummary] = useState<CompletionSummary | null>(null);

	// Velocity chart
	const [velocityData, setVelocityData] = useState<SprintVelocity[]>([]);
	const [velocityLoading, setVelocityLoading] = useState(false);

	useEffect(() => {
		const id = new URLSearchParams(window.location.search).get("projectId");
		setProjectId(id);
	}, []);

	const fetchSprints = useCallback(
		async (pid: string) => {
			setLoading(true);
			setError(null);
			try {
				const headers = buildHeaders(workspaceSlug);
				const [projRes, sprintRes] = await Promise.all([
					fetch(`/api/projects/${pid}`, { credentials: "include", headers }),
					fetch(`/api/sprints?projectId=${encodeURIComponent(pid)}`, {
						credentials: "include",
						headers,
					}),
				]);
				if (!projRes.ok) throw new Error(`Failed to load project (HTTP ${projRes.status})`);
				setProject((await projRes.json()) as Project);

				if (sprintRes.ok) {
					const data = (await sprintRes.json()) as { items: Sprint[] };
					setSprints(Array.isArray(data?.items) ? data.items : []);
				}
			} catch (e) {
				setError(String(e));
			} finally {
				setLoading(false);
			}
		},
		[workspaceSlug]
	);

	useEffect(() => {
		if (projectId) fetchSprints(projectId);
	}, [projectId, fetchSprints]);

	// Fetch issues for completed sprints to build velocity chart
	useEffect(() => {
		const completed = sprints.filter((s) => s.status === "completed").slice(-6);
		if (completed.length === 0) {
			setVelocityData([]);
			return;
		}

		let cancelled = false;
		setVelocityLoading(true);

		Promise.all(
			completed.map((sprint) =>
				apiFetch<{ items: Issue[] }>(
					`/api/issues?sprintId=${encodeURIComponent(sprint.id)}&limit=100`,
					{ workspaceSlug }
				)
					.then((data) => ({
						sprint,
						pointsCompleted: data.items
							.filter((i) => i.status_category === "done")
							.reduce((sum, i) => sum + getStoryPoints(i), 0),
						pointsTotal: data.items.reduce((sum, i) => sum + getStoryPoints(i), 0),
					}))
					.catch(() => ({ sprint, pointsCompleted: 0, pointsTotal: 0 }))
			)
		)
			.then((results) => {
				if (!cancelled) setVelocityData(results);
			})
			.finally(() => {
				if (!cancelled) setVelocityLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [sprints, workspaceSlug]);

	function openCreate() {
		setShowCreate(true);
		setCreateName("");
		setCreateGoal("");
		setCreateStart("");
		setCreateEnd("");
		setCreateError(null);
	}

	async function handleCreate(e: Event) {
		e.preventDefault();
		if (!projectId || !createName.trim()) return;

		setCreating(true);
		setCreateError(null);
		try {
			const body: Record<string, unknown> = {
				name: createName.trim(),
				projectId,
			};
			if (createGoal.trim()) body.goal = createGoal.trim();
			if (createStart) body.startDate = createStart;
			if (createEnd) body.endDate = createEnd;

			await apiFetch("/api/sprints", {
				method: "POST",
				workspaceSlug,
				body,
			});
			setShowCreate(false);
			await fetchSprints(projectId);
		} catch (e) {
			setCreateError(String(e));
		} finally {
			setCreating(false);
		}
	}

	async function handleComplete(id: string) {
		setCompleting(true);
		setCompleteError(null);
		try {
			const sprintBeingCompleted = sprints.find((s) => s.id === id);

			// Fetch sprint issues before completing so we can show the summary
			const issueData = await apiFetch<{ items: Issue[] }>(
				`/api/issues?sprintId=${encodeURIComponent(id)}&limit=100`,
				{ workspaceSlug }
			).catch(() => ({ items: [] as Issue[] }));

			await apiFetch(`/api/sprints/${id}`, {
				method: "PATCH",
				workspaceSlug,
				body: { status: "completed" },
			});

			setCompleteId(null);
			if (sprintBeingCompleted) {
				setCompletionSummary({ sprint: sprintBeingCompleted, issues: issueData.items });
			}
			if (projectId) await fetchSprints(projectId);
		} catch (e) {
			setCompleteError(String(e));
		} finally {
			setCompleting(false);
		}
	}

	if (!projectId && !loading) {
		return <p class="text-text-muted">No project specified. Add ?projectId= to the URL.</p>;
	}

	if (loading) return <p aria-live="polite">Loading sprints…</p>;
	if (error)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);

	const activeCount = sprints.filter((s) => s.status === "active").length;
	const completedSprints = sprints.filter((s) => s.status === "completed");

	return (
		<div>
			{/* Breadcrumb */}
			{project && (
				<nav class="text-sm text-text-muted mb-2">
					<a href="/" class="text-text-muted no-underline">
						Projects
					</a>
					<span class="mx-[0.375rem]">/</span>
					<a
						href={`/projects/view?id=${project.id}`}
						class="text-text-muted no-underline"
					>
						{project.name}
					</a>
					<span class="mx-[0.375rem]">/</span>
					Sprints
				</nav>
			)}

			{/* Title */}
			<div class="flex items-center gap-3 mb-5">
				<h1 class="m-0 text-2xl font-bold text-text-base">
					Sprints
				</h1>
				{project && (
					<span class="font-mono text-xs px-2 py-[0.125rem] rounded bg-surface border border-border text-text-muted">
						{project.key}
					</span>
				)}
			</div>

			{/* Completion summary */}
			{completionSummary && (
				<CompletionSummaryPanel
					summary={completionSummary}
					onClose={() => setCompletionSummary(null)}
				/>
			)}

			{/* Active sprint warning */}
			{activeCount >= 1 && !showCreate && (
				<div
					role="status"
					class="mb-4 px-[0.875rem] py-[0.625rem] bg-[rgba(37,99,235,0.08)] border border-[rgba(37,99,235,0.25)] rounded-md text-sm text-[var(--status-in-progress)]"
				>
					Sprint <strong>{sprints.find((s) => s.status === "active")?.name}</strong> is currently
					active.
				</div>
			)}

			{/* Header row */}
			<div class="flex justify-between items-center mb-4">
				<p class="m-0 text-sm text-text-muted">
					{sprints.length} sprint{sprints.length !== 1 ? "s" : ""}
				</p>
				{!showCreate && (
					<button type="button" class="btn btn-primary btn-sm" onClick={openCreate}>
						+ New sprint
					</button>
				)}
			</div>

			{/* Create form */}
			{showCreate && (
				<div class="mb-6 px-5 py-4 bg-surface border border-border rounded-lg">
					<h3 class="m-0 mb-4 text-base font-semibold text-text-base">New sprint</h3>

					{activeCount >= 1 && (
						<div
							role="alert"
							class="mb-[0.875rem] px-3 py-2 bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded text-[0.8rem] text-[var(--danger-text)]"
						>
							A sprint is already active. Only one sprint can be active at a time — the backend
							will reject activating a second one.
						</div>
					)}

					<form onSubmit={handleCreate}>
						<div class="mb-4">
							<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]" for="spr-name">
								Name *
							</label>
							<input
								id="spr-name"
								class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
								type="text"
								placeholder="e.g. Sprint 1"
								value={createName}
								onInput={(e) => setCreateName((e.target as HTMLInputElement).value)}
								required
								maxLength={100}
							/>
						</div>

						<div class="mb-4">
							<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]" for="spr-goal">
								Goal (optional)
							</label>
							<input
								id="spr-goal"
								class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
								type="text"
								placeholder="What do you want to achieve this sprint?"
								value={createGoal}
								onInput={(e) => setCreateGoal((e.target as HTMLInputElement).value)}
								maxLength={280}
							/>
						</div>

						<div class="flex flex-col sm:flex-row gap-4 mb-4">
							<div class="flex-1">
								<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]" for="spr-start">
									Start date (optional)
								</label>
								<input
									id="spr-start"
									class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
									type="date"
									value={createStart}
									onInput={(e) => setCreateStart((e.target as HTMLInputElement).value)}
								/>
							</div>
							<div class="flex-1">
								<label class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]" for="spr-end">
									End date (optional)
								</label>
								<input
									id="spr-end"
									class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
									type="date"
									value={createEnd}
									onInput={(e) => setCreateEnd((e.target as HTMLInputElement).value)}
								/>
							</div>
						</div>

						{createError && (
							<p role="alert" class="text-[var(--danger-text)] text-[0.8rem] m-0 mb-3">
								{createError}
							</p>
						)}

						<div class="flex gap-2 max-sm:flex-col">
							<button
								type="submit"
								class="btn btn-primary btn-sm max-sm:w-full"
								disabled={creating || !createName.trim()}
							>
								{creating ? "Creating…" : "Create sprint"}
							</button>
							<button
								type="button"
								class="btn btn-outline btn-sm max-sm:w-full"
								onClick={() => setShowCreate(false)}
								disabled={creating}
							>
								Cancel
							</button>
						</div>
					</form>
				</div>
			)}

			{/* Sprint list */}
			{sprints.length === 0 ? (
				<div class="p-8 text-center text-text-muted bg-surface rounded-lg border border-border">
					<p class="m-0 mb-2">No sprints yet.</p>
					<p class="m-0 text-sm">
						Create a sprint to organise issues into time-boxed iterations.
					</p>
				</div>
			) : (
				<div>
					{sprints.map((sprint) => (
						<div key={sprint.id} class="px-5 py-4 bg-surface border border-border rounded-lg mb-3 last:mb-0">
							<div class="flex items-center gap-3 flex-wrap mb-[0.375rem]">
								<span class="font-semibold text-base text-text-base">{sprint.name}</span>
								{statusBadge(sprint.status)}
							</div>
							{sprint.goal && <p class="text-sm text-text-muted italic mb-2">{sprint.goal}</p>}
							<div class="text-[0.8rem] text-text-muted flex gap-4 flex-wrap mb-2">
								<span>
									Start:{" "}
									<strong class="text-text-base">
										{formatDate(sprint.startDate)}
									</strong>
								</span>
								<span>
									End:{" "}
									<strong class="text-text-base">{formatDate(sprint.endDate)}</strong>
								</span>
							</div>
							<div class="flex gap-2 items-center flex-wrap">
								<a
									href={`/issues?sprintId=${encodeURIComponent(sprint.id)}`}
									class="btn btn-outline btn-sm"
								>
									View issues →
								</a>

								{sprint.status === "active" && (
									<>
										{completeId === sprint.id ? (
											<span class="inline-flex gap-[0.375rem] items-center">
												<span class="text-[0.8rem] text-text-muted">
													Mark complete?
												</span>
												<button
													type="button"
													class="btn btn-danger btn-sm"
													disabled={completing}
													onClick={() => handleComplete(sprint.id)}
												>
													{completing ? "…" : "Yes, complete"}
												</button>
												<button
													type="button"
													class="btn btn-outline btn-sm"
													disabled={completing}
													onClick={() => setCompleteId(null)}
												>
													Cancel
												</button>
												{completeError && (
													<span class="text-[var(--danger-text)] text-xs">
														{completeError}
													</span>
												)}
											</span>
										) : (
											<button
												type="button"
												class="btn btn-outline btn-sm"
												onClick={() => {
													setCompleteId(sprint.id);
													setCompleteError(null);
												}}
											>
												Complete sprint
											</button>
										)}
									</>
								)}
							</div>
						</div>
					))}
				</div>
			)}

			{/* Velocity chart */}
			{(completedSprints.length > 0 || velocityLoading) && (
				<VelocityChart data={velocityData} loading={velocityLoading} />
			)}
		</div>
	);
}
