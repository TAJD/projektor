import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { statusDisplayName } from "../lib/status";
import { apiFetch, buildHeaders } from "../utils/api-client";

interface Project {
	id: string;
	name: string;
	key: string;
	description: string | null;
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

export default function ProjectLanding({ workspaceSlug }: Props) {
	const [projectId, setProjectId] = useState<string | null>(null);
	useEffect(() => {
		const id = new URLSearchParams(window.location.search).get("id");
		setProjectId(id);
	}, []);

	const [project, setProject] = useState<Project | null>(null);
	const [recentIssues, setRecentIssues] = useState<RecentIssue[]>([]);
	const [recentWiki, setRecentWiki] = useState<RecentWikiPage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Description edit state
	const [editingDesc, setEditingDesc] = useState(false);
	const [editDesc, setEditDesc] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const fetchData = useCallback(
		async (id: string) => {
			setLoading(true);
			setError(null);
			try {
				const headers = buildHeaders(workspaceSlug);
				const [projRes, issuesRes, wikiRes] = await Promise.all([
					fetch(`/api/projects/${id}`, { credentials: "include", headers }),
					fetch(`/api/issues?project=${id}`, { credentials: "include", headers }),
					fetch(`/api/wiki?projectId=${encodeURIComponent(id)}`, {
						credentials: "include",
						headers,
					}),
				]);

				if (!projRes.ok) throw new Error(`Failed to load project (HTTP ${projRes.status})`);

				const proj = (await projRes.json()) as Project;
				setProject(proj);

				if (issuesRes.ok) {
					const data = (await issuesRes.json()) as { items: RecentIssue[] };
					const sorted = (Array.isArray(data?.items) ? data.items : [])
						.slice()
						.sort((a, b) => b.updated_at - a.updated_at)
						.slice(0, 5);
					setRecentIssues(sorted);
				}

				if (wikiRes.ok) {
					const wiki = (await wikiRes.json()) as RecentWikiPage[];
					const sorted = (Array.isArray(wiki) ? wiki : [])
						.slice()
						.sort((a, b) => b.updated_at - a.updated_at)
						.slice(0, 5);
					setRecentWiki(sorted);
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
		if (projectId) fetchData(projectId);
	}, [projectId, fetchData]);

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
			await apiFetch(`/api/projects/${project.id}`, {
				method: "PATCH",
				workspaceSlug,
				body: { description: editDesc.trim() || null },
			});
			setProject((prev) => (prev ? { ...prev, description: editDesc.trim() || null } : prev));
			setEditingDesc(false);
		} catch (e) {
			setSaveError(`Save failed: ${String(e)}`);
		} finally {
			setSaving(false);
		}
	}

	if (!projectId && !loading) {
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
						Projektor
					</a>
					<span class="mx-[0.375rem]">/</span>
					<a href="/projects" class="text-text-muted no-underline">
						Projects
					</a>
					<span class="mx-[0.375rem]">/</span>
					{project.name}
				</nav>

				<div class="flex items-center gap-3 mb-2">
					<h1 class="m-0 text-2xl font-bold text-text-base">{project.name}</h1>
					<span class="font-mono text-xs font-medium px-2 py-[0.125rem] rounded bg-surface border border-border text-text-muted">
						{project.key}
					</span>
				</div>

				{/* Editable description */}
				<div class="max-w-[640px]">
					{editingDesc ? (
						<div>
							<textarea
								ref={textareaRef}
								value={editDesc}
								rows={3}
								onInput={(e) => setEditDesc((e.target as HTMLTextAreaElement).value)}
								class="w-full px-3 py-2 border border-border rounded text-sm bg-bg text-text-base font-[inherit] leading-[1.5] resize-y"
								maxLength={500}
								aria-label="Project description"
							/>
							{saveError && (
								<p role="alert" class="text-[var(--danger-text)] text-[0.8rem] my-1">
									{saveError}
								</p>
							)}
							<div class="flex gap-2 mt-2">
								<button
									type="button"
									onClick={saveDesc}
									disabled={saving}
									class={`btn btn-primary btn-sm${saving ? " opacity-60" : ""}`}
								>
									{saving ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									onClick={cancelEditDesc}
									disabled={saving}
									class="btn btn-outline btn-sm"
								>
									Cancel
								</button>
							</div>
						</div>
					) : (
						// biome-ignore lint/a11y/useSemanticElements: div contains block-level <p> content, so a native <button> would be invalid HTML; implemented as a fully-keyboard-accessible ARIA button
						<div
							role="button"
							tabIndex={0}
							class="cursor-pointer px-2 py-[0.375rem] rounded border border-transparent transition-[border-color,background] duration-100 hover:border-border hover:bg-surface"
							onClick={startEditDesc}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") startEditDesc();
							}}
							title="Click to edit description"
							aria-label="Edit project description"
						>
							{project.description ? (
								<p class="m-0 text-text-base text-[0.9375rem] leading-[1.6]">
									{project.description}
								</p>
							) : (
								<p class="m-0 text-text-muted text-sm italic">Add a description…</p>
							)}
						</div>
					)}
				</div>
			</header>

			{/* Recent Issues */}
			<section class="mb-8" aria-labelledby="recent-issues-heading">
				<h2
					id="recent-issues-heading"
					class="text-xs font-semibold text-text-muted m-0 mb-3 uppercase tracking-[0.05em]"
				>
					Recent Issues
				</h2>
				{recentIssues.length === 0 ? (
					<p class="text-text-muted text-sm py-2">No issues yet.</p>
				) : (
					<div>
						{recentIssues.map((issue) => {
							const ref = issue.project_key
								? `${issue.project_key}-${issue.number}`
								: `#${issue.number}`;
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
									<a
										href={`/issues/view?id=${issue.id}`}
										class="text-text-base no-underline text-sm flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap hover:underline focus:underline"
									>
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

			{/* Recent Wiki Pages */}
			<section class="mb-8" aria-labelledby="recent-wiki-heading">
				<h2
					id="recent-wiki-heading"
					class="text-xs font-semibold text-text-muted m-0 mb-3 uppercase tracking-[0.05em]"
				>
					Recent Wiki Pages
				</h2>
				{recentWiki.length === 0 ? (
					<p class="text-text-muted text-sm py-2">No wiki pages yet.</p>
				) : (
					<div>
						{recentWiki.map((page) => (
							<div key={page.id} class="py-2 border-b border-border last:border-b-0">
								<div class="flex justify-between items-baseline gap-2">
									<a
										href={`/wiki?slug=${encodeURIComponent(page.slug)}`}
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
		</div>
	);
}
