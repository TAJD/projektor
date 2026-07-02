import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { slugify } from "../lib/slugify";
import { apiFetch } from "../utils/api-client";
import { renderMdWithWikilinks, renderMermaidDiagrams } from "../utils/markdown";
import MarkdownEditor from "./MarkdownEditor";

interface SearchResult {
	id: string;
	slug: string;
	title: string;
	project_id: string | null;
	excerpt: string | null;
}

interface WikiPageData {
	id: string;
	slug: string;
	title: string;
	content: string;
	parent_id: string | null;
	updated_at: number;
}

interface TreeNode {
	id: string;
	slug: string;
	title: string;
	children: TreeNode[];
}

interface FlatEntry {
	id: string;
	slug: string;
	title: string;
	parentId: string | null;
}

interface TocItem {
	level: number;
	text: string;
	id: string;
}

interface WikiRevision {
	id: string;
	author_id: string | null;
	author_name: string | null;
	created_at: number;
}

interface Attachment {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	createdAt: number;
}

interface Props {
	workspaceSlug?: string;
	projectId?: string;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function draftKey(pageId: string): string {
	return `wiki-draft:${pageId}`;
}

function flattenTree(nodes: TreeNode[], parentId: string | null = null): Record<string, FlatEntry> {
	const map: Record<string, FlatEntry> = {};
	for (const node of nodes) {
		map[node.id] = { id: node.id, slug: node.slug, title: node.title, parentId };
		const childMap = flattenTree(node.children, node.id);
		for (const [k, v] of Object.entries(childMap)) map[k] = v;
	}
	return map;
}

function getBreadcrumbs(pageId: string, map: Record<string, FlatEntry>): FlatEntry[] {
	const crumbs: FlatEntry[] = [];
	let cur: FlatEntry | undefined = map[pageId];
	const seen = new Set<string>();
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		crumbs.unshift(cur);
		cur = cur.parentId ? map[cur.parentId] : undefined;
	}
	return crumbs;
}

function TreeNodeItem({
	node,
	currentSlug,
	depth,
	onNavigate,
}: {
	node: TreeNode;
	currentSlug: string;
	depth: number;
	onNavigate: (slug: string) => void;
}) {
	const isActive = currentSlug === node.slug;
	return (
		<li>
			<button
				type="button"
				class={`block w-full text-left py-[0.375rem] px-2 rounded border-none cursor-pointer text-sm bg-transparent text-text-base hover:bg-border focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${isActive ? "!bg-accent !text-white font-semibold" : ""}`}
				style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
				onClick={() => onNavigate(node.slug)}
			>
				{depth > 0 && <span class="text-text-muted mr-1">{"›"}</span>}
				{node.title}
			</button>
			{node.children.length > 0 && (
				<ul class="list-none m-0 p-0">
					{node.children.map((child) => (
						<TreeNodeItem
							key={child.id}
							node={child}
							currentSlug={currentSlug}
							depth={depth + 1}
							onNavigate={onNavigate}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

export default function WikiPage({ workspaceSlug, projectId: projectIdProp }: Props) {
	const [slug, setSlug] = useState("");
	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	const [page, setPage] = useState<WikiPageData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [pageTree, setPageTree] = useState<TreeNode[]>([]);
	const [pageMap, setPageMap] = useState<Record<string, FlatEntry>>({});
	const [treeLoading, setTreeLoading] = useState(false);

	const [editing, setEditing] = useState(false);
	const [editTitle, setEditTitle] = useState("");
	const [editContent, setEditContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [draftBanner, setDraftBanner] = useState<{
		title: string;
		content: string;
		savedAt: number;
	} | null>(null);

	const [creating, setCreating] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createSlug, setCreateSlug] = useState("");
	const [createContent, setCreateContent] = useState("");
	const [createParentId, setCreateParentId] = useState<string | null>(null);
	const [createError, setCreateError] = useState<string | null>(null);
	const [createSaving, setCreateSaving] = useState(false);
	const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

	const [revisions, setRevisions] = useState<WikiRevision[]>([]);
	const [showHistory, setShowHistory] = useState(false);

	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
	const [searchLoading, setSearchLoading] = useState(false);

	// Attachments
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [uploadFormOpen, setUploadFormOpen] = useState(false);
	const [uploadFile, setUploadFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);

	// PROJ-113: ToC state
	const [toc, setToc] = useState<TocItem[]>([]);
	const [activeHeadingId, setActiveHeadingId] = useState("");
	const contentRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setSlug(params.get("slug") ?? "");
		if (!projectIdProp) setProjectId(params.get("projectId") ?? "");
		const prefilledTitle = params.get("createTitle");
		if (prefilledTitle) {
			setCreating(true);
			setCreateTitle(prefilledTitle);
			setCreateSlug(slugify(prefilledTitle));
		}
	}, [projectIdProp]);

	const fetchTree = useCallback(async () => {
		setTreeLoading(true);
		try {
			const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
			const data = await apiFetch<TreeNode[]>(`/api/wiki/tree${qs}`, { workspaceSlug });
			const tree = Array.isArray(data) ? data : [];
			setPageTree(tree);
			setPageMap(flattenTree(tree));
		} catch {
			// non-fatal
		} finally {
			setTreeLoading(false);
		}
	}, [workspaceSlug, projectId]);

	useEffect(() => {
		fetchTree();
	}, [fetchTree]);

	useEffect(() => {
		if (!searchQuery.trim()) {
			setSearchResults([]);
			return;
		}
		setSearchLoading(true);
		const timer = setTimeout(async () => {
			try {
				const qs = new URLSearchParams({ q: searchQuery });
				if (projectId) qs.set("projectId", projectId);
				const data = await apiFetch<SearchResult[]>(`/api/wiki/search?${qs}`, { workspaceSlug });
				setSearchResults(Array.isArray(data) ? data : []);
			} catch {
				// non-fatal
			} finally {
				setSearchLoading(false);
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery, workspaceSlug, projectId]);

	const fetchPage = useCallback(
		async (s: string) => {
			if (!s) return;
			setLoading(true);
			setError(null);
			setRevisions([]);
			setShowHistory(false);
			setToc([]);
			setAttachments([]);
			try {
				setPage(
					await apiFetch<WikiPageData>(`/api/wiki/${encodeURIComponent(s)}`, { workspaceSlug })
				);
			} catch (e) {
				setError(String(e));
			} finally {
				setLoading(false);
			}
		},
		[workspaceSlug]
	);

	const fetchRevisions = useCallback(
		async (s: string) => {
			try {
				const data = await apiFetch<WikiRevision[]>(
					`/api/wiki/${encodeURIComponent(s)}/revisions`,
					{ workspaceSlug }
				);
				setRevisions(Array.isArray(data) ? data : []);
			} catch {
				// non-fatal
			}
		},
		[workspaceSlug]
	);

	const fetchAttachments = useCallback(
		async (pageId: string) => {
			try {
				const qs = new URLSearchParams({ entityType: "wiki_page", entityId: pageId });
				const data = await apiFetch<Attachment[]>(`/api/files?${qs}`, { workspaceSlug });
				setAttachments(Array.isArray(data) ? data : []);
			} catch {
				// non-fatal
			}
		},
		[workspaceSlug]
	);

	useEffect(() => {
		if (slug) {
			fetchPage(slug);
			fetchRevisions(slug);
		}
	}, [slug, fetchPage, fetchRevisions]);

	useEffect(() => {
		if (page?.id) fetchAttachments(page.id);
	}, [page?.id, fetchAttachments]);

	// PROJ-113: build ToC after content renders
	useEffect(() => {
		const container = contentRef.current;
		if (!container || !page) {
			setToc([]);
			return;
		}
		const headings = Array.from(container.querySelectorAll("h1, h2, h3")) as HTMLElement[];
		headings.forEach((h) => {
			if (!h.id) {
				h.id = (h.textContent ?? "")
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "");
			}
		});
		setToc(
			headings.map((h) => ({
				level: parseInt(h.tagName[1], 10),
				text: h.textContent ?? "",
				id: h.id,
			}))
		);
	}, [page?.content]);

	// Hydrate ```mermaid code blocks into rendered diagrams
	useEffect(() => {
		const container = contentRef.current;
		if (!container || !page) return;
		renderMermaidDiagrams(container).catch(() => {
			// non-fatal — leave the raw code block visible
		});
	}, [page?.content]);

	// PROJ-113: IntersectionObserver for active heading
	useEffect(() => {
		if (toc.length < 3) return;
		const container = contentRef.current;
		if (!container) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setActiveHeadingId(entry.target.id);
						break;
					}
				}
			},
			{ rootMargin: "-10% 0% -70% 0%", threshold: 0 }
		);
		const headings = container.querySelectorAll("h1[id], h2[id], h3[id]");
		headings.forEach((h) => {
			observer.observe(h);
		});
		return () => observer.disconnect();
	}, [toc]);

	// PROJ-227: debounced draft autosave to localStorage while editing
	useEffect(() => {
		if (!editing || !page || draftBanner) return;
		const timer = setTimeout(() => {
			try {
				localStorage.setItem(
					draftKey(page.id),
					JSON.stringify({ title: editTitle, content: editContent, savedAt: Date.now() })
				);
			} catch {
				// non-fatal
			}
		}, 1000);
		return () => clearTimeout(timer);
	}, [editing, editTitle, editContent, page, draftBanner]);

	// Latest edit state for the flush-on-leave effect below, since its cleanup
	// closure would otherwise only see the values from when `editing` last changed.
	const latestDraftStateRef = useRef({ editTitle, editContent, page, draftBanner });
	latestDraftStateRef.current = { editTitle, editContent, page, draftBanner };

	// save() clears the draft itself right before leaving edit mode; set this to
	// suppress the flush below so it doesn't resurrect the just-cleared draft.
	const skipLeaveFlushRef = useRef(false);

	// Flush any not-yet-debounced edits to localStorage when leaving edit mode
	// via navigation (not just Save/Cancel), so a quick click-away doesn't drop
	// the last <1s of keystrokes from the safety-net draft.
	useEffect(() => {
		const wasEditing = editing;
		return () => {
			if (!wasEditing) return;
			if (skipLeaveFlushRef.current) {
				skipLeaveFlushRef.current = false;
				return;
			}
			const {
				editTitle: t,
				editContent: c,
				page: p,
				draftBanner: db,
			} = latestDraftStateRef.current;
			if (!p || db) return;
			try {
				localStorage.setItem(
					draftKey(p.id),
					JSON.stringify({ title: t, content: c, savedAt: Date.now() })
				);
			} catch {
				// non-fatal
			}
		};
	}, [editing]);

	function navigateTo(s: string) {
		setCreating(false);
		setEditing(false);
		setPage(null);
		setError(null);
		setToc([]);
		setSlug(s);
		history.pushState(null, "", `?slug=${encodeURIComponent(s)}`);
	}

	function startEdit() {
		if (!page) return;
		setSaveError(null);
		setDraftBanner(null);
		setEditTitle(page.title);
		setEditContent(page.content);
		try {
			const raw = localStorage.getItem(draftKey(page.id));
			if (raw) {
				const draft = JSON.parse(raw);
				if (draft && typeof draft.savedAt === "number" && draft.savedAt > page.updated_at * 1000) {
					setDraftBanner(draft);
				}
			}
		} catch {
			// non-fatal — treat as no draft
		}
		setEditing(true);
	}

	function restoreDraft() {
		if (!draftBanner) return;
		setEditTitle(draftBanner.title);
		setEditContent(draftBanner.content);
		setDraftBanner(null);
	}

	function discardDraft() {
		if (!page) return;
		try {
			localStorage.removeItem(draftKey(page.id));
		} catch {
			// non-fatal
		}
		setEditTitle(page.title);
		setEditContent(page.content);
		setDraftBanner(null);
	}

	function cancelEdit() {
		setEditing(false);
		setSaveError(null);
		setDraftBanner(null);
	}

	async function save() {
		if (!page) return;
		setSaving(true);
		setSaveError(null);
		try {
			await apiFetch(`/api/wiki/${encodeURIComponent(page.slug)}`, {
				method: "PUT",
				workspaceSlug,
				body: { title: editTitle, content: editContent },
			});
			try {
				localStorage.removeItem(draftKey(page.id));
			} catch {
				// non-fatal
			}
			await fetchPage(page.slug);
			await fetchRevisions(page.slug);
			skipLeaveFlushRef.current = true;
			setEditing(false);
		} catch (e) {
			setSaveError(`Save failed: ${String(e)}`);
		} finally {
			setSaving(false);
		}
	}

	async function deletePage() {
		if (!page) return;
		if (!window.confirm(`Delete "${page.title}"? This cannot be undone.`)) return;
		try {
			await apiFetch(`/api/wiki/${encodeURIComponent(page.slug)}`, {
				method: "DELETE",
				workspaceSlug,
			});
			setPage(null);
			setSlug("");
			history.pushState(null, "", window.location.pathname);
			await fetchTree();
		} catch (e) {
			alert(`Delete failed: ${String(e)}`);
		}
	}

	function startCreate(parentId: string | null = null) {
		setCreating(true);
		setEditing(false);
		setCreateTitle("");
		setCreateSlug("");
		setCreateContent("");
		setCreateParentId(parentId);
		setCreateError(null);
		setSlugManuallyEdited(false);
	}

	function cancelCreate() {
		setCreating(false);
		setCreateError(null);
	}

	async function submitCreate() {
		if (!createTitle.trim()) {
			setCreateError("Title is required.");
			return;
		}
		const finalSlug = createSlug.trim() || slugify(createTitle);
		if (!finalSlug) {
			setCreateError("Slug could not be derived from title.");
			return;
		}
		setCreateSaving(true);
		setCreateError(null);
		try {
			const created = await apiFetch<{ id: string; slug: string }>("/api/wiki", {
				method: "POST",
				workspaceSlug,
				body: {
					title: createTitle.trim(),
					slug: finalSlug,
					content: createContent,
					...(projectId ? { projectId } : {}),
					...(createParentId ? { parentId: createParentId } : {}),
				},
			});
			setCreating(false);
			await fetchTree();
			navigateTo(created.slug);
		} catch (e) {
			setCreateError(`Create failed: ${String(e)}`);
		} finally {
			setCreateSaving(false);
		}
	}

	async function uploadAttachment() {
		if (!uploadFile || !page) return;
		setUploading(true);
		setUploadError(null);
		try {
			const form = new FormData();
			form.append("file", uploadFile);
			form.append("entityType", "wiki_page");
			form.append("entityId", page.id);
			await apiFetch("/api/files", { workspaceSlug, method: "POST", body: form });
			setUploadFile(null);
			setUploadFormOpen(false);
			await fetchAttachments(page.id);
		} catch (e) {
			setUploadError(String(e));
		} finally {
			setUploading(false);
		}
	}

	async function deleteAttachment(attachmentId: string) {
		if (!page) return;
		try {
			await apiFetch(`/api/files/${attachmentId}`, { workspaceSlug, method: "DELETE" });
			await fetchAttachments(page.id);
		} catch {
			// non-fatal
		}
	}

	const latestRevision = revisions[0] ?? null;

	// Breadcrumbs for current page (PROJ-114)
	const breadcrumbs = page ? getBreadcrumbs(page.id, pageMap) : [];

	// ToC sidebar (PROJ-113) — only when viewing page, ≥3 headings
	const showToc = !editing && !creating && toc.length >= 3;

	function TocList({ onClick }: { onClick?: () => void }) {
		return (
			<>
				{toc.map((item) => {
					const isTocActive = activeHeadingId === item.id;
					return (
						<a
							key={item.id}
							href={`#${item.id}`}
							class={`block py-[0.2rem] no-underline border-l-2 transition-[color,border-color] duration-150 ${isTocActive ? "text-accent border-accent font-medium" : "text-text-muted border-border hover:text-accent hover:border-accent"}`}
							style={{ paddingLeft: `${(item.level - 1) * 0.75 + 0.5}rem` }}
							onClick={onClick}
						>
							{item.text}
						</a>
					);
				})}
			</>
		);
	}

	const createParentTitle = createParentId ? pageMap[createParentId]?.title : null;

	const wikiPages = Object.values(pageMap);

	return (
		<div class="flex min-h-screen max-sm:flex-col">
			<style>{`
				.wiki-link-broken { color: var(--text-muted); text-decoration: underline; text-decoration-style: dashed; text-underline-offset: 2px; }
				.wiki-link-broken a { font-size: 0.8em; margin-left: 0.2em; color: var(--text-muted); text-decoration: none; border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; }
				.wiki-link-broken a:hover { color: var(--accent); border-color: var(--accent); }
				.prose pre.mermaid { display: flex; justify-content: center; background: none; padding: 0; }
				.prose pre.mermaid svg { max-width: 100%; width: auto; height: auto; }
				@media (max-width: 640px) {
					.wiki-breadcrumb button { max-width: 8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				}
			`}</style>
			{/* Left sidebar: page tree */}
			<aside class="w-[240px] shrink-0 bg-surface border-r border-border p-4 overflow-y-auto max-sm:w-full max-sm:border-r-0 max-sm:border-b">
				<button
					type="button"
					onClick={() => startCreate(null)}
					class="btn btn-primary w-full mb-4 max-sm:min-h-[44px]"
				>
					+ New page
				</button>
				<input
					type="search"
					value={searchQuery}
					onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
					placeholder="Search pages…"
					class="w-full px-3 py-[0.375rem] mb-3 border border-border rounded text-sm bg-bg text-text-base box-border"
					aria-label="Search wiki pages"
				/>
				{searchQuery.trim() ? (
					searchLoading ? (
						<p class="text-[0.8rem] text-text-muted m-0">Searching…</p>
					) : searchResults.length === 0 ? (
						<p class="text-[0.8rem] text-text-muted m-0">No results</p>
					) : (
						<ul class="list-none m-0 p-0">
							{searchResults.map((r) => (
								<li key={r.id}>
									<button
										type="button"
										class="block w-full text-left py-[0.375rem] px-2 rounded border-none cursor-pointer text-sm bg-transparent text-text-base hover:bg-border focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
										onClick={() => {
											setSearchQuery("");
											navigateTo(r.slug);
										}}
									>
										<span class="font-medium">{r.title}</span>
										{r.excerpt && (
											<span class="block text-[0.75rem] text-text-muted truncate">{r.excerpt}</span>
										)}
									</button>
								</li>
							))}
						</ul>
					)
				) : treeLoading ? (
					<p class="text-[0.8rem] text-text-muted m-0">Loading…</p>
				) : (
					<ul class="list-none m-0 p-0">
						{pageTree.map((node) => (
							<TreeNodeItem
								key={node.id}
								node={node}
								currentSlug={slug}
								depth={0}
								onNavigate={navigateTo}
							/>
						))}
						{pageTree.length === 0 && <li class="text-[0.8rem] text-text-muted">No pages yet</li>}
					</ul>
				)}
			</aside>

			{/* Main */}
			<main class="flex-1 p-8 min-w-0">
				{creating ? (
					<div>
						<h2 class="mb-6 text-2xl font-bold text-text-base">
							{createParentTitle ? `New child page under "${createParentTitle}"` : "New page"}
						</h2>
						{createError && (
							<p role="alert" class="text-[var(--danger-text)] mb-3">
								{createError}
							</p>
						)}
						<div class="mb-4">
							<label htmlFor="create-title" class="block font-medium text-sm text-text-base mb-1">
								Title <span class="text-[var(--danger-text)]">*</span>
							</label>
							<input
								id="create-title"
								type="text"
								value={createTitle}
								onInput={(e) => {
									const v = (e.target as HTMLInputElement).value;
									setCreateTitle(v);
									if (!slugManuallyEdited) setCreateSlug(slugify(v));
								}}
								placeholder="Page title"
								class="w-full px-3 py-2 border border-border rounded text-sm bg-bg text-text-base box-border text-base"
							/>
						</div>
						<div class="mb-4">
							<label htmlFor="create-slug" class="block font-medium text-sm text-text-base mb-1">
								Slug
							</label>
							<input
								id="create-slug"
								type="text"
								value={createSlug}
								onInput={(e) => {
									setCreateSlug((e.target as HTMLInputElement).value);
									setSlugManuallyEdited(true);
								}}
								placeholder="auto-derived-from-title"
								class="w-full px-3 py-2 border border-border rounded text-sm bg-bg text-text-base box-border font-mono"
							/>
						</div>
						<div class="mb-5">
							{/* biome-ignore lint/a11y/noLabelWithoutControl: caption for the MarkdownEditor rich-text component, which exposes no associable form control */}
							<label class="block font-medium text-sm text-text-base mb-1">
								Content (Markdown)
							</label>
							<MarkdownEditor value={createContent} onChange={setCreateContent} minHeight="280px" />
						</div>
						<div class="flex gap-2">
							<button
								type="button"
								onClick={submitCreate}
								disabled={createSaving}
								class="btn btn-primary"
							>
								{createSaving ? "Creating…" : "Create page"}
							</button>
							<button
								type="button"
								onClick={cancelCreate}
								disabled={createSaving}
								class="btn btn-outline"
							>
								Cancel
							</button>
						</div>
					</div>
				) : !slug ? (
					<p class="text-text-muted">Select a page from the sidebar or create a new one.</p>
				) : loading ? (
					<p aria-live="polite">Loading…</p>
				) : error ? (
					<p role="alert" class="text-[var(--danger-text)]">
						Failed to load page: {error}
					</p>
				) : !page ? null : (
					<div class="flex gap-8 items-start">
						<article class="flex-1 min-w-0">
							{/* Breadcrumbs (PROJ-114) */}
							{breadcrumbs.length > 1 && (
								<nav
									class="wiki-breadcrumb text-[0.8rem] text-text-muted mb-3 flex flex-wrap gap-1 items-center"
									aria-label="Breadcrumb"
								>
									<button
										type="button"
										class="bg-transparent border-none cursor-pointer text-text-muted text-[0.8rem] p-0 underline decoration-transparent hover:text-accent hover:decoration-accent"
										onClick={() => navigateTo(breadcrumbs[0].slug)}
									>
										Home
									</button>
									{breadcrumbs.slice(1, -1).map((crumb) => (
										<>
											<span>›</span>
											<button
												key={crumb.id}
												type="button"
												class="bg-transparent border-none cursor-pointer text-text-muted text-[0.8rem] p-0 underline decoration-transparent hover:text-accent hover:decoration-accent"
												onClick={() => navigateTo(crumb.slug)}
											>
												{crumb.title}
											</button>
										</>
									))}
									<span>›</span>
									<span class="text-text-base">{breadcrumbs[breadcrumbs.length - 1].title}</span>
								</nav>
							)}

							{/* Mobile ToC (PROJ-113) */}
							{showToc && (
								<details class="mb-4 max-[900px]:block min-[901px]:hidden">
									<summary class="cursor-pointer text-[0.8rem] text-text-muted select-none">
										Contents ({toc.length})
									</summary>
									<div class="pt-2">
										<TocList />
									</div>
								</details>
							)}

							<header class="flex items-start justify-between gap-4 mb-1">
								{editing ? (
									<input
										id="wiki-title"
										type="text"
										value={editTitle}
										onInput={(e) => setEditTitle((e.target as HTMLInputElement).value)}
										aria-label="Page title"
										class="flex-1 px-3 py-2 border border-border rounded text-sm bg-bg text-text-base box-border text-2xl font-bold"
									/>
								) : (
									<h1 class="m-0 text-[1.75rem] font-bold text-text-base">{page.title}</h1>
								)}

								<div class="flex gap-2 shrink-0">
									{editing ? (
										<>
											<button
												type="button"
												onClick={save}
												disabled={saving}
												class="btn btn-primary"
											>
												{saving ? "Saving…" : "Save"}
											</button>
											<button
												type="button"
												onClick={cancelEdit}
												disabled={saving}
												class="btn btn-outline"
											>
												Cancel
											</button>
										</>
									) : (
										<>
											<button
												type="button"
												onClick={() => startCreate(page.id)}
												class="btn btn-outline btn-sm"
											>
												+ Child page
											</button>
											<button type="button" onClick={startEdit} class="btn btn-outline">
												Edit
											</button>
											<button type="button" onClick={deletePage} class="btn btn-danger">
												Delete
											</button>
										</>
									)}
								</div>
							</header>

							{latestRevision && (
								<p class="text-[0.8rem] text-text-muted mt-1 mb-5">
									Last edited by{" "}
									<strong class="text-text-base">{latestRevision.author_name ?? "Unknown"}</strong>{" "}
									at {new Date(latestRevision.created_at * 1000).toLocaleString()}
								</p>
							)}

							{saveError && (
								<p role="alert" class="text-[var(--danger-text)] mb-3">
									{saveError}
								</p>
							)}

							{editing && draftBanner && (
								<div class="mb-3 px-3 py-2 border border-border rounded bg-surface text-sm flex items-center justify-between gap-3 flex-wrap">
									<span>
										Restore unsaved draft from {new Date(draftBanner.savedAt).toLocaleString()}?
									</span>
									<div class="flex gap-2 shrink-0">
										<button type="button" onClick={restoreDraft} class="btn btn-primary btn-sm">
											Restore
										</button>
										<button type="button" onClick={discardDraft} class="btn btn-outline btn-sm">
											Discard
										</button>
									</div>
								</div>
							)}

							{editing ? (
								<div class="mb-3">
									<MarkdownEditor value={editContent} onChange={setEditContent} minHeight="320px" />
								</div>
							) : (
								<div
									ref={contentRef}
									class="prose prose-sm max-w-none"
									dangerouslySetInnerHTML={{
										__html: renderMdWithWikilinks(page.content, wikiPages),
									}}
								/>
							)}

							{revisions.length > 0 && (
								<div class="mt-8">
									<button
										type="button"
										onClick={() => setShowHistory((h) => !h)}
										class="btn btn-outline btn-sm text-text-muted"
									>
										{showHistory ? "▲ Hide history" : "▼ History"} ({revisions.length})
									</button>
									{showHistory && (
										<ul class="mt-3 list-none p-0">
											{revisions.map((r) => (
												<li
													key={r.id}
													class="py-[0.375rem] border-b border-border text-[0.8rem] text-text-muted"
												>
													<strong class="text-text-base">{r.author_name ?? "Unknown"}</strong>
													{" — "}
													{new Date(r.created_at * 1000).toLocaleString()}
												</li>
											))}
										</ul>
									)}
								</div>
							)}

							{/* Attachments */}
							<div class="mt-8">
								<h3 class="text-xs uppercase tracking-[0.05em] text-text-muted font-semibold mb-3 pb-2 border-b border-border">
									{`Attachments${attachments.length > 0 ? ` (${attachments.length})` : ""}`}
								</h3>

								{attachments.length > 0 && (
									<div class="mb-4 flex flex-col gap-2">
										{attachments.map((a) => {
											const qs = workspaceSlug ? `?workspace=${workspaceSlug}` : "";
											return (
												<div
													key={a.id}
													class="flex items-center gap-3 px-3 py-2 border border-border rounded-md bg-surface"
												>
													<a
														href={`/api/files/${a.id}${qs}`}
														target="_blank"
														rel="noreferrer"
														class="text-accent text-sm no-underline hover:underline flex-1 min-w-0 truncate"
													>
														{a.filename}
													</a>
													<span class="text-xs text-text-muted shrink-0">
														{formatBytes(a.size)}
													</span>
													<button
														type="button"
														onClick={() => deleteAttachment(a.id)}
														aria-label={`Delete ${a.filename}`}
														class="btn btn-sm bg-transparent border-none text-text-muted px-[0.125rem] leading-none"
													>
														×
													</button>
												</div>
											);
										})}
									</div>
								)}

								{uploadFormOpen ? (
									<div class="flex flex-wrap gap-2 items-center">
										<label class="relative cursor-pointer">
											<input
												type="file"
												class="sr-only"
												onChange={(e) => {
													const f = (e.target as HTMLInputElement).files?.[0] ?? null;
													setUploadFile(f);
													setUploadError(null);
												}}
											/>
											<span class="btn btn-outline btn-sm">
												{uploadFile ? uploadFile.name : "Choose file"}
											</span>
										</label>
										<button
											type="button"
											onClick={uploadAttachment}
											disabled={!uploadFile || uploading}
											class="btn btn-primary"
										>
											{uploading ? "Uploading…" : "Upload"}
										</button>
										<button
											type="button"
											onClick={() => {
												setUploadFormOpen(false);
												setUploadFile(null);
												setUploadError(null);
											}}
											class="btn btn-outline"
										>
											Cancel
										</button>
										{uploadError && (
											<span
												role="alert"
												class="text-[0.8rem] text-[var(--danger-text)] self-center"
											>
												{uploadError}
											</span>
										)}
									</div>
								) : (
									<button
										type="button"
										onClick={() => setUploadFormOpen(true)}
										class="text-sm text-text-muted hover:text-text-base transition-colors flex items-center gap-1"
									>
										<span class="text-base leading-none">+</span>
										<span>Attach file</span>
									</button>
								)}
							</div>

							<footer class="mt-8 pt-4 border-t border-border text-xs text-text-muted">
								Last updated: {new Date(page.updated_at * 1000).toLocaleString()}
							</footer>
						</article>

						{/* Sticky ToC sidebar — desktop only (PROJ-113) */}
						{showToc && (
							<nav
								class="w-[190px] shrink-0 sticky top-6 self-start max-h-[calc(100vh-3rem)] overflow-y-auto text-[0.8rem] max-[900px]:hidden"
								aria-label="Table of contents"
							>
								<h3 class="m-0 mb-2 text-xs uppercase tracking-[0.05em] text-text-muted font-semibold">
									Contents
								</h3>
								<TocList />
							</nav>
						)}
					</div>
				)}
			</main>
		</div>
	);
}
