import type { RefObject } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
	currentProject,
	ensureProjectResolved,
	type ProjectSummary,
	projectReady,
	projectError as storeProjectError,
} from "../lib/project-context";
import { statusDisplayName } from "../lib/status";
import { apiFetch } from "../utils/api-client";
import { usePublicViewer } from "../utils/public-viewer";
import ProjectFlowCharts from "./ProjectFlowCharts";
import { Button } from "./ui/Button";

interface Project {
	id: string;
	name: string;
	key: string;
	slug: string | null;
	description: string | null;
	archivedAt: number | null;
	workspaceId: string;
	createdAt: number;
	updatedAt: number;
}

interface RecentIssue {
	id: string;
	number: number;
	title: string;
	project_key: string | null;
	status_name: string | null;
	status_key: string | null;
	status_category: string | null;
	updated_at: number;
}

interface RecentWikiPage {
	id: string;
	slug: string;
	title: string;
	updated_at: number;
}

interface Props {
	workspaceSlug?: string;
}

const CATEGORY_COLORS: Record<string, string> = {
	todo: "var(--status-todo)",
	in_progress: "var(--status-in-progress)",
	in_review: "var(--status-in-review)",
	done: "var(--status-done)",
	cancelled: "var(--status-cancelled)",
};

const KEY_BADGE_CLASS =
	"font-mono text-xs font-medium px-2 py-[0.125rem] rounded bg-surface border border-border text-text-muted";
const TEXTAREA_CLASS =
	"w-full px-3 py-2 border border-border rounded text-sm bg-bg text-text-base font-[inherit] leading-[1.5] resize-y";
const DESC_VIEW_CLASS =
	"cursor-pointer px-2 py-[0.375rem] rounded border border-transparent " +
	"transition-[border-color,background] duration-100 hover:border-border hover:bg-surface";
const SECTION_HEADING_CLASS =
	"text-xs font-semibold text-text-muted m-0 mb-3 uppercase tracking-[0.05em]";
const ISSUE_LINK_CLASS =
	"text-text-base no-underline text-sm flex-1 min-w-0 overflow-hidden text-ellipsis " +
	"whitespace-nowrap hover:underline focus:underline";

function sortByRecency<T extends { updated_at: number }>(items: unknown, limit: number): T[] {
	return (Array.isArray(items) ? (items as T[]) : [])
		.slice()
		.sort((a, b) => b.updated_at - a.updated_at)
		.slice(0, limit);
}

async function loadProjectData(
	idOrSlug: string,
	workspaceSlug: string | undefined,
	setters: Readonly<{
		setProject: (p: Project) => void;
		setRecentIssues: (v: RecentIssue[]) => void;
		setRecentWiki: (v: RecentWikiPage[]) => void;
	}>
) {
	// /api/projects/:id resolves either a UUID or a slug, but the issues/wiki
	// endpoints below filter on the real project UUID — resolve the project first.
	const proj = await apiFetch<Project>(`/api/projects/${encodeURIComponent(idOrSlug)}`, {
		workspaceSlug,
	});
	setters.setProject(proj);

	const [issuesData, wikiData] = await Promise.all([
		apiFetch<{ items: RecentIssue[] }>(`/api/issues?project=${proj.id}`, { workspaceSlug }).catch(
			() => null
		),
		apiFetch<RecentWikiPage[]>(`/api/wiki?projectId=${encodeURIComponent(proj.id)}`, {
			workspaceSlug,
		}).catch(() => null),
	]);

	if (issuesData) setters.setRecentIssues(sortByRecency<RecentIssue>(issuesData?.items, 5));
	if (wikiData) setters.setRecentWiki(sortByRecency<RecentWikiPage>(wikiData, 5));
}

function useDescriptionEditing(
	project: Project | null,
	workspaceSlug: string | undefined,
	onSaved: (description: string | null) => void
) {
	const [editingDesc, setEditingDesc] = useState(false);
	const [editDesc, setEditDesc] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	function startEditDesc() {
		if (!project) return;
		setEditDesc(project.description ?? "");
		setSaveError(null);
		setEditingDesc(true);
		setTimeout(() => textareaRef.current?.focus(), 0);
	}

	function cancelEditDesc() {
		setEditingDesc(false);
		setSaveError(null);
	}

	async function saveDesc() {
		if (!project) return;
		setSaving(true);
		setSaveError(null);
		try {
			const description = editDesc.trim() || null;
			await apiFetch(`/api/projects/${project.id}`, {
				method: "PATCH",
				workspaceSlug,
				body: { description },
			});
			onSaved(description);
			setEditingDesc(false);
		} catch (e) {
			setSaveError(`Save failed: ${String(e)}`);
		} finally {
			setSaving(false);
		}
	}

	return {
		editingDesc,
		editDesc,
		setEditDesc,
		saving,
		saveError,
		textareaRef,
		startEditDesc,
		cancelEditDesc,
		saveDesc,
	};
}

function DescriptionEditor({
	project,
	editingDesc,
	editDesc,
	setEditDesc,
	saving,
	saveError,
	textareaRef,
	onSave,
	onCancel,
	onStartEdit,
	canEdit,
}: {
	project: Project;
	editingDesc: boolean;
	editDesc: string;
	setEditDesc: (value: string) => void;
	saving: boolean;
	saveError: string | null;
	textareaRef: RefObject<HTMLTextAreaElement>;
	onSave: () => void;
	onCancel: () => void;
	onStartEdit: () => void;
	canEdit: boolean;
}) {
	if (editingDesc) {
		return (
			<DescriptionEditForm
				editDesc={editDesc}
				setEditDesc={setEditDesc}
				saving={saving}
				saveError={saveError}
				textareaRef={textareaRef}
				onSave={onSave}
				onCancel={onCancel}
			/>
		);
	}
	return <DescriptionView project={project} onStartEdit={canEdit ? onStartEdit : undefined} />;
}

function DescriptionEditForm({
	editDesc,
	setEditDesc,
	saving,
	saveError,
	textareaRef,
	onSave,
	onCancel,
}: {
	editDesc: string;
	setEditDesc: (value: string) => void;
	saving: boolean;
	saveError: string | null;
	textareaRef: RefObject<HTMLTextAreaElement>;
	onSave: () => void;
	onCancel: () => void;
}) {
	return (
		<div>
			<textarea
				ref={textareaRef}
				value={editDesc}
				rows={3}
				onInput={(e) => setEditDesc((e.target as HTMLTextAreaElement).value)}
				class={TEXTAREA_CLASS}
				maxLength={500}
				aria-label="Project description"
			/>
			{saveError && (
				<p role="alert" class="text-[var(--danger-text)] text-[0.8rem] my-1">
					{saveError}
				</p>
			)}
			<div class="flex gap-2 mt-2">
				<Button type="button" variant="primary" size="sm" onClick={onSave} disabled={saving}>
					{saving ? "Saving…" : "Save"}
				</Button>
				<Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function DescriptionView({
	project,
	onStartEdit,
}: {
	project: Project;
	onStartEdit: (() => void) | undefined;
}) {
	if (!onStartEdit) {
		return project.description ? (
			<p class="m-0 text-text-base text-[0.9375rem] leading-[1.6] px-2 py-[0.375rem]">
				{project.description}
			</p>
		) : (
			<p class="m-0 text-text-muted text-sm italic px-2 py-[0.375rem]">No description.</p>
		);
	}
	return (
		// biome-ignore lint/a11y/useSemanticElements: div wraps block-level <p>; button can't nest <p>
		<div
			role="button"
			tabIndex={0}
			class={DESC_VIEW_CLASS}
			onClick={onStartEdit}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") onStartEdit();
			}}
			title="Click to edit description"
			aria-label="Edit project description"
		>
			{project.description ? (
				<p class="m-0 text-text-base text-[0.9375rem] leading-[1.6]">{project.description}</p>
			) : (
				<p class="m-0 text-text-muted text-sm italic">Add a description…</p>
			)}
		</div>
	);
}

function issueRef(issue: RecentIssue) {
	return issue.project_key ? `${issue.project_key}-${issue.number}` : `#${issue.number}`;
}

function RecentIssuesSection({ issues }: { issues: RecentIssue[] }) {
	return (
		<section class="mb-8" aria-labelledby="recent-issues-heading">
			<h2 id="recent-issues-heading" class={SECTION_HEADING_CLASS}>
				Recent Issues
			</h2>
			{issues.length === 0 ? (
				<p class="text-text-muted text-sm py-2">No issues yet.</p>
			) : (
				<div>
					{issues.map((issue) => {
						const ref = issueRef(issue);
						const color = CATEGORY_COLORS[issue.status_category ?? ""] ?? "var(--text-muted)";
						return (
							<div
								key={issue.id}
								class="flex items-baseline gap-2 py-2 border-b border-border last:border-b-0"
							>
								<span class="font-mono text-xs text-text-muted shrink-0">{ref}</span>
								<span class="text-[0.8rem] font-medium shrink-0 min-w-[4rem]" style={{ color }}>
									{statusDisplayName(issue.status_name, issue.status_key)}
								</span>
								<a href={`/issues/view?id=${issue.id}`} class={ISSUE_LINK_CLASS}>
									{issue.title}
								</a>
								<span class="text-xs text-text-muted shrink-0">
									{new Date(issue.updated_at * 1000).toLocaleDateString()}
								</span>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

function RecentWikiSection({ pages }: { pages: RecentWikiPage[] }) {
	return (
		<section class="mb-8" aria-labelledby="recent-wiki-heading">
			<h2 id="recent-wiki-heading" class={SECTION_HEADING_CLASS}>
				Recent Wiki Pages
			</h2>
			{pages.length === 0 ? (
				<p class="text-text-muted text-sm py-2">No wiki pages yet.</p>
			) : (
				<div>
					{pages.map((page) => (
						<div key={page.id} class="py-2 border-b border-border last:border-b-0">
							<div class="flex justify-between items-baseline gap-2">
								<a
									href={`/wiki/${encodeURIComponent(page.slug)}`}
									class="text-text-base no-underline text-sm hover:underline focus:underline"
								>
									{page.title}
								</a>
								<span class="text-xs text-text-muted shrink-0">
									{new Date(page.updated_at * 1000).toLocaleDateString()}
								</span>
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

const matchesHint = (p: ProjectSummary, h: string) => p.id === h || p.key === h || p.slug === h;

export default function ProjectLanding({ workspaceSlug }: Props) {
	const hint =
		typeof window === "undefined"
			? null
			: (() => {
					const params = new URLSearchParams(window.location.search);
					const slugMatch = window.location.pathname.match(/^\/projects\/view\/([^/]+)\/?$/);
					return (
						params.get("id") || params.get("projectId") || slugMatch?.[1] || params.get("project")
					);
				})();

	useEffect(() => {
		ensureProjectResolved(workspaceSlug, hint || null, matchesHint);
	}, [workspaceSlug, hint]);

	const projectId = projectReady.value ? (currentProject.value?.id ?? null) : undefined;
	const resolveError = storeProjectError.value;
	const isPublicViewer = usePublicViewer(workspaceSlug);

	const [project, setProject] = useState<Project | null>(null);
	const [recentIssues, setRecentIssues] = useState<RecentIssue[]>([]);
	const [recentWiki, setRecentWiki] = useState<RecentWikiPage[]>([]);
	const [loading, setLoading] = useState(true);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const error = resolveError ?? fetchError;

	const {
		editingDesc,
		editDesc,
		setEditDesc,
		saving,
		saveError,
		textareaRef,
		startEditDesc,
		cancelEditDesc,
		saveDesc,
	} = useDescriptionEditing(project, workspaceSlug, (description) =>
		setProject((prev) => (prev ? { ...prev, description } : prev))
	);

	const [archiving, setArchiving] = useState(false);
	const toggleArchived = useCallback(async () => {
		if (!project || archiving) return;
		setArchiving(true);
		try {
			const archived = project.archivedAt == null;
			await apiFetch(`/api/projects/${project.id}`, {
				method: "PATCH",
				workspaceSlug,
				body: { archived },
			});
			setProject((prev) =>
				prev ? { ...prev, archivedAt: archived ? Math.floor(Date.now() / 1000) : null } : prev
			);
		} finally {
			setArchiving(false);
		}
	}, [project, archiving, workspaceSlug]);

	const fetchData = useCallback(
		async (id: string) => {
			setLoading(true);
			setFetchError(null);
			try {
				await loadProjectData(id, workspaceSlug, { setProject, setRecentIssues, setRecentWiki });
			} catch (e) {
				setFetchError(String(e));
			} finally {
				setLoading(false);
			}
		},
		[workspaceSlug]
	);

	useEffect(() => {
		if (projectId === undefined) return;
		if (!projectId) {
			setLoading(false);
			return;
		}
		fetchData(projectId);
	}, [projectId, fetchData]);

	if (!projectId && !loading && !error) {
		return <p class="text-text-muted">No project specified.</p>;
	}

	if (loading) return <p aria-live="polite">Loading…</p>;
	if (error)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);
	if (!project) return null;

	return (
		<div>
			{/* Header */}
			<header class="mb-6">
				<nav class="text-sm text-text-muted mb-2">
					<a href="/" class="text-text-muted no-underline">
						Projects
					</a>
					<span class="mx-[0.375rem]">/</span>
					{project.name}
				</nav>

				<div class="flex items-center gap-3 mb-2">
					<h1 class="m-0 text-2xl font-bold text-text-base">{project.name}</h1>
					<span class={KEY_BADGE_CLASS}>{project.key}</span>
					{project.archivedAt != null && <span class={KEY_BADGE_CLASS}>Archived</span>}
					{!isPublicViewer && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={toggleArchived}
							disabled={archiving}
						>
							{project.archivedAt != null ? "Unarchive" : "Archive"}
						</Button>
					)}
				</div>

				<div class="max-w-[640px]">
					<DescriptionEditor
						project={project}
						editingDesc={editingDesc}
						editDesc={editDesc}
						setEditDesc={setEditDesc}
						saving={saving}
						saveError={saveError}
						textareaRef={textareaRef}
						onSave={saveDesc}
						onCancel={cancelEditDesc}
						onStartEdit={startEditDesc}
						canEdit={!isPublicViewer}
					/>
				</div>
			</header>

			<ProjectFlowCharts workspaceSlug={workspaceSlug} projectId={project.id} />
			<RecentIssuesSection issues={recentIssues} />
			<RecentWikiSection pages={recentWiki} />
		</div>
	);
}
