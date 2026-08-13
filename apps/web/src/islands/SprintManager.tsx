import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import type { CustomFieldValue, ProjectLookup as Project } from "./board-utils";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";

export interface Sprint {
	id: string;
	name: string;
	goal: string | null;
	status: "planned" | "active" | "completed";
	startDate: string | null;
	endDate: string | null;
	projectId: string;
	createdAt: number;
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
		active: { bg: "var(--sprint-active-bg)", color: "var(--status-in-progress)" },
		completed: { bg: "var(--sprint-completed-bg)", color: "var(--status-done)" },
	};
	const s = styles[status] ?? styles.planned;
	return (
		<Badge
			class="border border-current font-semibold capitalize"
			style={{ background: s.bg, color: s.color }}
		>
			{status}
		</Badge>
	);
}

function formatDate(d: string | null): string {
	if (!d) return "—";
	return new Date(d).toLocaleDateString();
}

async function fetchSprintIssues(
	sprintId: string,
	workspaceSlug: string | undefined
): Promise<Issue[]> {
	const data = await apiFetch<{ items: Issue[] }>(
		`/api/issues?sprintId=${encodeURIComponent(sprintId)}&limit=100`,
		{ workspaceSlug }
	).catch(() => ({ items: [] as Issue[] }));
	return data.items;
}

function computeVelocity(sprint: Sprint, issues: readonly Issue[]): SprintVelocity {
	return {
		sprint,
		pointsCompleted: issues
			.filter((i) => i.status_category === "done")
			.reduce((sum, i) => sum + getStoryPoints(i), 0),
		pointsTotal: issues.reduce((sum, i) => sum + getStoryPoints(i), 0),
	};
}

function activeCountOf(sprints: readonly Sprint[]): number {
	return sprints.filter((s) => s.status === "active").length;
}

function completedSprintsOf(sprints: readonly Sprint[]): Sprint[] {
	return sprints.filter((s) => s.status === "completed");
}

function sprintCountLabel(n: number): string {
	return `${n} sprint${n !== 1 ? "s" : ""}`;
}

function shouldShowActiveNotice(activeCount: number, showCreate: boolean): boolean {
	return activeCount >= 1 && !showCreate;
}

function shouldShowVelocity(completedCount: number, velocityLoading: boolean): boolean {
	return completedCount > 0 || velocityLoading;
}

function buildCreateSprintBody(
	projectId: string,
	name: string,
	goal: string,
	start: string,
	end: string
): Record<string, unknown> {
	const body: Record<string, unknown> = { name: name.trim(), projectId };
	if (goal.trim()) body.goal = goal.trim();
	if (start) body.startDate = start;
	if (end) body.endDate = end;
	return body;
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
		<div class="mb-6 px-5 py-4 bg-[var(--success-bg)] border border-[var(--success-border)] rounded-lg">
			<div class="flex justify-between items-start mb-3">
				<h3 class="m-0 text-base font-semibold text-text-base">Sprint complete: {sprint.name}</h3>
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
						<strong class="text-text-base">
							{doneSP}/{totalSP}
						</strong>
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

function VelocityChart({ data, loading }: { data: SprintVelocity[]; loading: boolean }) {
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
							const doneH = totalH > 0 ? Math.round((pointsCompleted / pointsTotal) * totalH) : 0;
							return (
								<div
									key={sprint.id}
									class="flex-1 flex flex-col items-center justify-end min-w-0"
									style={{ height: `${BAR_AREA_PX + 48}px` }}
								>
									<div class="text-[0.7rem] font-semibold text-text-base mb-1">
										{pointsCompleted}
										{pointsTotal > 0 && pointsCompleted !== pointsTotal && (
											<span class="font-normal text-text-muted">/{pointsTotal}</span>
										)}
									</div>
									<div
										class="relative w-full rounded-t"
										style={{
											height: `${Math.max(totalH, 2)}px`,
											background: "var(--velocity-bar-bg)",
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
								class="inline-block w-3 h-2 rounded-xs"
								style={{ background: "var(--status-done)", opacity: "0.8" }}
							/>
							Completed SP
						</span>
						<span class="inline-flex items-center gap-1">
							<span
								class="inline-block w-3 h-2 rounded-xs"
								style={{ background: "var(--velocity-bar-bg)" }}
							/>
							Total SP
						</span>
					</div>
				</div>
			)}
		</div>
	);
}

function useSprintData(workspaceSlug: string | undefined) {
	const [projectId, setProjectId] = useState<string | null>(null);
	const [project, setProject] = useState<Project | null>(null);
	const [sprints, setSprints] = useState<Sprint[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const id = new URLSearchParams(window.location.search).get("projectId");
		setProjectId(id);
		if (!id) setLoading(false);
	}, []);

	const fetchSprints = useCallback(
		async (pid: string) => {
			setLoading(true);
			setError(null);
			try {
				const [proj, sprintData] = await Promise.all([
					apiFetch<Project>(`/api/projects/${pid}`, { workspaceSlug }),
					apiFetch<{ items: Sprint[] }>(`/api/sprints?projectId=${encodeURIComponent(pid)}`, {
						workspaceSlug,
					}).catch(() => null),
				]);
				setProject(proj);

				if (sprintData) {
					setSprints(Array.isArray(sprintData?.items) ? sprintData.items : []);
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

	// cofferdam-ignore: Consistency.ErrorHandlingIdiom: hook returns {data,error,loading} state, standard in this codebase
	return { projectId, project, sprints, loading, error, fetchSprints };
}

function useSprintVelocity(sprints: readonly Sprint[], workspaceSlug: string | undefined) {
	const [velocityData, setVelocityData] = useState<SprintVelocity[]>([]);
	const [velocityLoading, setVelocityLoading] = useState(false);

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
				fetchSprintIssues(sprint.id, workspaceSlug).then((issues) =>
					computeVelocity(sprint, issues)
				)
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

	return { velocityData, velocityLoading };
}

function useSprintCreateForm(
	projectId: string | null,
	workspaceSlug: string | undefined,
	refetch: (pid: string) => Promise<void>
) {
	const [showCreate, setShowCreate] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createGoal, setCreateGoal] = useState("");
	const [createStart, setCreateStart] = useState("");
	const [createEnd, setCreateEnd] = useState("");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	function open() {
		setShowCreate(true);
		setCreateName("");
		setCreateGoal("");
		setCreateStart("");
		setCreateEnd("");
		setCreateError(null);
	}

	function close() {
		setShowCreate(false);
	}

	async function submit(e: Event) {
		e.preventDefault();
		if (!projectId || !createName.trim()) return;

		setCreating(true);
		setCreateError(null);
		try {
			await apiFetch("/api/sprints", {
				method: "POST",
				workspaceSlug,
				body: buildCreateSprintBody(projectId, createName, createGoal, createStart, createEnd),
			});
			setShowCreate(false);
			await refetch(projectId);
		} catch (e) {
			setCreateError(String(e));
		} finally {
			setCreating(false);
		}
	}

	return {
		showCreate,
		createName,
		createGoal,
		createStart,
		createEnd,
		creating,
		createError,
		setCreateName,
		setCreateGoal,
		setCreateStart,
		setCreateEnd,
		open,
		close,
		submit,
	};
}

function useSprintComplete(
	projectId: string | null,
	sprints: readonly Sprint[],
	workspaceSlug: string | undefined,
	refetch: (pid: string) => Promise<void>
) {
	const [completeId, setCompleteId] = useState<string | null>(null);
	const [completing, setCompleting] = useState(false);
	const [completeError, setCompleteError] = useState<string | null>(null);
	const [completionSummary, setCompletionSummary] = useState<CompletionSummary | null>(null);

	function start(id: string) {
		setCompleteId(id);
		setCompleteError(null);
	}

	function cancel() {
		setCompleteId(null);
	}

	async function confirm(id: string) {
		setCompleting(true);
		setCompleteError(null);
		try {
			const sprintBeingCompleted = sprints.find((s) => s.id === id);
			const issues = await fetchSprintIssues(id, workspaceSlug);

			await apiFetch(`/api/sprints/${id}`, {
				method: "PATCH",
				workspaceSlug,
				body: { status: "completed" },
			});

			setCompleteId(null);
			if (sprintBeingCompleted) {
				setCompletionSummary({ sprint: sprintBeingCompleted, issues });
			}
			if (projectId) await refetch(projectId);
		} catch (e) {
			setCompleteError(String(e));
		} finally {
			setCompleting(false);
		}
	}

	return {
		completeId,
		completing,
		completeError,
		completionSummary,
		setCompletionSummary,
		start,
		cancel,
		confirm,
	};
}

interface SprintManagerContentProps {
	project: Project | null;
	sprints: Sprint[];
	createForm: ReturnType<typeof useSprintCreateForm>;
	complete: ReturnType<typeof useSprintComplete>;
	velocity: ReturnType<typeof useSprintVelocity>;
}

function SprintManagerContent({
	project,
	sprints,
	createForm,
	complete,
	velocity,
}: SprintManagerContentProps) {
	const activeCount = activeCountOf(sprints);
	const completedSprints = completedSprintsOf(sprints);
	const showActiveNotice = shouldShowActiveNotice(activeCount, createForm.showCreate);
	const showVelocity = shouldShowVelocity(completedSprints.length, velocity.velocityLoading);

	return (
		<div>
			<SprintBreadcrumb project={project} />

			{/* Title */}
			<div class="flex items-center gap-3 mb-5">
				<h1 class="m-0 text-2xl font-bold text-text-base">Sprints</h1>
				{project && (
					<span class="font-mono text-xs px-2 py-[0.125rem] rounded bg-surface border border-border text-text-muted">
						{project.key}
					</span>
				)}
			</div>

			{/* Completion summary */}
			{complete.completionSummary && (
				<CompletionSummaryPanel
					summary={complete.completionSummary}
					onClose={() => complete.setCompletionSummary(null)}
				/>
			)}

			{/* Active sprint warning */}
			{showActiveNotice && <ActiveSprintNotice sprints={sprints} />}

			{/* Header row */}
			<div class="flex justify-between items-center mb-4">
				<p class="m-0 text-sm text-text-muted">{sprintCountLabel(sprints.length)}</p>
				{!createForm.showCreate && (
					<Button variant="primary" size="sm" onClick={createForm.open}>
						+ New sprint
					</Button>
				)}
			</div>

			{/* Create form */}
			{createForm.showCreate && (
				<CreateSprintForm
					activeCount={activeCount}
					createName={createForm.createName}
					createGoal={createForm.createGoal}
					createStart={createForm.createStart}
					createEnd={createForm.createEnd}
					creating={createForm.creating}
					createError={createForm.createError}
					onNameChange={createForm.setCreateName}
					onGoalChange={createForm.setCreateGoal}
					onStartChange={createForm.setCreateStart}
					onEndChange={createForm.setCreateEnd}
					onSubmit={createForm.submit}
					onCancel={createForm.close}
				/>
			)}

			{/* Sprint list */}
			<SprintList
				sprints={sprints}
				completeId={complete.completeId}
				completing={complete.completing}
				completeError={complete.completeError}
				onStartComplete={complete.start}
				onConfirmComplete={complete.confirm}
				onCancelComplete={complete.cancel}
			/>

			{/* Velocity chart */}
			{showVelocity && (
				<VelocityChart data={velocity.velocityData} loading={velocity.velocityLoading} />
			)}
		</div>
	);
}

export default function SprintManager({ workspaceSlug }: Props) {
	const { projectId, project, sprints, loading, error, fetchSprints } =
		useSprintData(workspaceSlug);
	const velocity = useSprintVelocity(sprints, workspaceSlug);
	const createForm = useSprintCreateForm(projectId, workspaceSlug, fetchSprints);
	const complete = useSprintComplete(projectId, sprints, workspaceSlug, fetchSprints);

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

	return (
		<SprintManagerContent
			project={project}
			sprints={sprints}
			createForm={createForm}
			complete={complete}
			velocity={velocity}
		/>
	);
}

function SprintBreadcrumb({ project }: { project: Project | null }) {
	if (!project) return null;
	return (
		<nav class="text-sm text-text-muted mb-2">
			<a href="/" class="text-text-muted no-underline">
				Projects
			</a>
			<span class="mx-[0.375rem]">/</span>
			<a href={`/projects/view?id=${project.id}`} class="text-text-muted no-underline">
				{project.name}
			</a>
			<span class="mx-[0.375rem]">/</span>
			Sprints
		</nav>
	);
}

const ACTIVE_SPRINT_NOTICE_CLASS =
	"mb-4 px-[0.875rem] py-[0.625rem] bg-[var(--sprint-notice-bg)] " +
	"border border-[var(--sprint-notice-border)] rounded-md text-sm text-[var(--status-in-progress)]";

function ActiveSprintNotice({ sprints }: { sprints: Sprint[] }) {
	const active = sprints.find((s) => s.status === "active");
	return (
		<div role="status" class={ACTIVE_SPRINT_NOTICE_CLASS}>
			Sprint <strong>{active?.name}</strong> is currently active.
		</div>
	);
}

const CREATE_FORM_ACTIVE_WARNING_CLASS =
	"mb-[0.875rem] px-3 py-2 bg-[var(--danger-bg)] border border-[var(--danger-border)] " +
	"rounded text-[0.8rem] text-[var(--danger-text)]";

interface CreateSprintFormProps {
	activeCount: number;
	createName: string;
	createGoal: string;
	createStart: string;
	createEnd: string;
	creating: boolean;
	createError: string | null;
	onNameChange: (v: string) => void;
	onGoalChange: (v: string) => void;
	onStartChange: (v: string) => void;
	onEndChange: (v: string) => void;
	onSubmit: (e: Event) => void;
	onCancel: () => void;
}

interface SprintDateFieldsProps {
	createStart: string;
	createEnd: string;
	onStartChange: (v: string) => void;
	onEndChange: (v: string) => void;
}

function SprintDateFields({
	createStart,
	createEnd,
	onStartChange,
	onEndChange,
}: SprintDateFieldsProps) {
	return (
		<div class="flex flex-col sm:flex-row gap-4 mb-4">
			<div class="flex-1">
				<label
					class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
					for="spr-start"
				>
					Start date (optional)
				</label>
				<input
					id="spr-start"
					class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
					type="date"
					value={createStart}
					onInput={(e) => onStartChange((e.target as HTMLInputElement).value)}
				/>
			</div>
			<div class="flex-1">
				<label
					class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
					for="spr-end"
				>
					End date (optional)
				</label>
				<input
					id="spr-end"
					class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
					type="date"
					value={createEnd}
					onInput={(e) => onEndChange((e.target as HTMLInputElement).value)}
				/>
			</div>
		</div>
	);
}

function CreateSprintForm({
	activeCount,
	createName,
	createGoal,
	createStart,
	createEnd,
	creating,
	createError,
	onNameChange,
	onGoalChange,
	onStartChange,
	onEndChange,
	onSubmit,
	onCancel,
}: CreateSprintFormProps) {
	return (
		<div class="mb-6 px-5 py-4 bg-surface border border-border rounded-lg">
			<h3 class="m-0 mb-4 text-base font-semibold text-text-base">New sprint</h3>

			{activeCount >= 1 && (
				<div role="alert" class={CREATE_FORM_ACTIVE_WARNING_CLASS}>
					A sprint is already active. Only one sprint can be active at a time — the backend will
					reject activating a second one.
				</div>
			)}

			<form onSubmit={onSubmit}>
				<div class="mb-4">
					<label
						class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
						for="spr-name"
					>
						Name *
					</label>
					<input
						id="spr-name"
						class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
						type="text"
						placeholder="e.g. Sprint 1"
						value={createName}
						onInput={(e) => onNameChange((e.target as HTMLInputElement).value)}
						required
						maxLength={100}
					/>
				</div>

				<div class="mb-4">
					<label
						class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
						for="spr-goal"
					>
						Goal (optional)
					</label>
					<input
						id="spr-goal"
						class="w-full px-3 py-[0.4rem] border border-border rounded text-sm bg-bg text-text-base"
						type="text"
						placeholder="What do you want to achieve this sprint?"
						value={createGoal}
						onInput={(e) => onGoalChange((e.target as HTMLInputElement).value)}
						maxLength={280}
					/>
				</div>

				<SprintDateFields
					createStart={createStart}
					createEnd={createEnd}
					onStartChange={onStartChange}
					onEndChange={onEndChange}
				/>

				{createError && (
					<p role="alert" class="text-[var(--danger-text)] text-[0.8rem] m-0 mb-3">
						{createError}
					</p>
				)}

				<div class="flex gap-2 max-sm:flex-col">
					<Button
						type="submit"
						variant="primary"
						size="sm"
						class="max-sm:w-full"
						disabled={creating || !createName.trim()}
					>
						{creating ? "Creating…" : "Create sprint"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="max-sm:w-full"
						onClick={onCancel}
						disabled={creating}
					>
						Cancel
					</Button>
				</div>
			</form>
		</div>
	);
}

interface SprintCompleteControlsProps {
	sprintId: string;
	active: boolean;
	completing: boolean;
	completeError: string | null;
	onStart: (id: string) => void;
	onConfirm: (id: string) => void;
	onCancel: () => void;
}

function SprintCompleteControls({
	sprintId,
	active,
	completing,
	completeError,
	onStart,
	onConfirm,
	onCancel,
}: SprintCompleteControlsProps) {
	if (!active) {
		return (
			<Button variant="outline" size="sm" onClick={() => onStart(sprintId)}>
				Complete sprint
			</Button>
		);
	}
	return (
		<span class="inline-flex gap-[0.375rem] items-center">
			<span class="text-[0.8rem] text-text-muted">Mark complete?</span>
			<Button variant="danger" size="sm" disabled={completing} onClick={() => onConfirm(sprintId)}>
				{completing ? "…" : "Yes, complete"}
			</Button>
			<Button variant="outline" size="sm" disabled={completing} onClick={onCancel}>
				Cancel
			</Button>
			{completeError && <span class="text-[var(--danger-text)] text-xs">{completeError}</span>}
		</span>
	);
}

interface SprintRowProps {
	sprint: Sprint;
	completeId: string | null;
	completing: boolean;
	completeError: string | null;
	onStartComplete: (id: string) => void;
	onConfirmComplete: (id: string) => void;
	onCancelComplete: () => void;
}

function SprintRow({
	sprint,
	completeId,
	completing,
	completeError,
	onStartComplete,
	onConfirmComplete,
	onCancelComplete,
}: SprintRowProps) {
	return (
		<div class="px-5 py-4 bg-surface border border-border rounded-lg mb-3 last:mb-0">
			<div class="flex items-center gap-3 flex-wrap mb-[0.375rem]">
				<span class="font-semibold text-base text-text-base">{sprint.name}</span>
				{statusBadge(sprint.status)}
			</div>
			{sprint.goal && <p class="text-sm text-text-muted italic mb-2">{sprint.goal}</p>}
			<div class="text-[0.8rem] text-text-muted flex gap-4 flex-wrap mb-2">
				<span>
					Start: <strong class="text-text-base">{formatDate(sprint.startDate)}</strong>
				</span>
				<span>
					End: <strong class="text-text-base">{formatDate(sprint.endDate)}</strong>
				</span>
			</div>
			<div class="flex gap-2 items-center flex-wrap">
				<Button
					as="a"
					href={`/issues?sprintId=${encodeURIComponent(sprint.id)}`}
					variant="outline"
					size="sm"
				>
					View issues →
				</Button>

				{sprint.status === "active" && (
					<SprintCompleteControls
						sprintId={sprint.id}
						active={completeId === sprint.id}
						completing={completing}
						completeError={completeError}
						onStart={onStartComplete}
						onConfirm={onConfirmComplete}
						onCancel={onCancelComplete}
					/>
				)}
			</div>
		</div>
	);
}

interface SprintListProps {
	sprints: Sprint[];
	completeId: string | null;
	completing: boolean;
	completeError: string | null;
	onStartComplete: (id: string) => void;
	onConfirmComplete: (id: string) => void;
	onCancelComplete: () => void;
}

function SprintList({
	sprints,
	completeId,
	completing,
	completeError,
	onStartComplete,
	onConfirmComplete,
	onCancelComplete,
}: SprintListProps) {
	if (sprints.length === 0) {
		return (
			<div class="p-8 text-center text-text-muted bg-surface rounded-lg border border-border">
				<p class="m-0 mb-2">No sprints yet.</p>
				<p class="m-0 text-sm">Create a sprint to organise issues into time-boxed iterations.</p>
			</div>
		);
	}
	return (
		<div>
			{sprints.map((sprint) => (
				<SprintRow
					key={sprint.id}
					sprint={sprint}
					completeId={completeId}
					completing={completing}
					completeError={completeError}
					onStartComplete={onStartComplete}
					onConfirmComplete={onConfirmComplete}
					onCancelComplete={onCancelComplete}
				/>
			))}
		</div>
	);
}
