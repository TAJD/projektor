import type { RefObject } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { slugify } from "../lib/slugify";
import { useAccessGate } from "../utils/access-gate";
import { apiFetch } from "../utils/api-client";
import { renderMdWithWikilinks, renderMermaidDiagrams, stripFrontmatter } from "../utils/markdown";
import AccessPending from "./AccessPending";
import MarkdownEditor from "./LazyMarkdownEditor";
import Select, { type SelectOption } from "./Select";

interface ProjectOption {
	id: string;
	key: string;
	name: string;
}

interface SearchResult {
	id: string;
	slug: string;
	title: string;
	project_id: string | null;
	excerpt: string | null;
	// PROJ-488 (R6): denormalized frontmatter metadata, surfaced as chips in search results.
	type: string | null;
	status: string | null;
	tags: string[];
}

interface WikiPageData {
	id: string;
	slug: string;
	title: string;
	content: string;
	parent_id: string | null;
	updated_at: number;
	// PROJ-488 (R6): optional YAML frontmatter, denormalized on the API side.
	type: string | null;
	tags: string[];
	status: string | null;
	verified_at: number | null;
	verified_by: string | null;
	owners: string[];
	verify_interval: number | null;
}

// PROJ-488: shape returned by GET /api/wiki (listWikiPages) — used for the sidebar's
// type/status/tags filtered browse view (WikiSidebar's flat list, distinct from the
// hierarchical tree shown when no filter is active).
interface WikiListItem {
	id: string;
	slug: string;
	title: string;
	type: string | null;
	status: string | null;
	tags: string[];
}

const WIKI_TYPE_FILTER_OPTIONS: SelectOption[] = [
	{ value: "", label: "All types" },
	{ value: "runbook", label: "Runbook" },
	{ value: "adr", label: "ADR" },
	{ value: "spec", label: "Spec" },
	{ value: "note", label: "Note" },
];

const WIKI_STATUS_FILTER_OPTIONS: SelectOption[] = [
	{ value: "", label: "All statuses" },
	{ value: "draft", label: "Draft" },
	{ value: "current", label: "Current" },
	{ value: "stale", label: "Stale" },
	{ value: "deprecated", label: "Deprecated" },
];

const WIKI_STATUS_PILL_STYLE: Record<string, { bg: string; color: string }> = {
	draft: { bg: "var(--priority-low-bg)", color: "var(--priority-low-text)" },
	current: { bg: "rgba(22, 163, 74, 0.12)", color: "var(--status-done)" },
	stale: { bg: "var(--priority-high-bg)", color: "var(--priority-high-text)" },
	deprecated: { bg: "var(--danger-bg)", color: "var(--danger-text)" },
};

function WikiStatusPill({ status }: { status: string }) {
	const style = WIKI_STATUS_PILL_STYLE[status] ?? {
		bg: "var(--priority-low-bg)",
		color: "var(--priority-low-text)",
	};
	return (
		<span
			class="inline-flex items-center px-2 py-[0.1rem] rounded-full text-[0.72rem] font-semibold uppercase tracking-wide"
			style={{ background: style.bg, color: style.color }}
		>
			{status}
		</span>
	);
}

const WIKI_TAG_CHIP_CLASS =
	"inline-flex items-center px-2 py-[0.1rem] mr-1 mb-1 rounded-full text-[0.72rem] " +
	"bg-bg border border-border text-text-base";

function TagChips({ tags }: { tags: string[] | undefined | null }) {
	if (!Array.isArray(tags) || tags.length === 0) return null;
	return (
		<span class="inline-flex flex-wrap align-middle">
			{tags.map((t) => (
				<span key={t} class={WIKI_TAG_CHIP_CLASS}>
					{t}
				</span>
			))}
		</span>
	);
}

// PROJ-488: header card summarizing a page's frontmatter metadata (type/status/tags/
// owners/verification). Omitted entirely for a page with no frontmatter at all, so
// pages predating this feature (or that simply don't use it) render exactly as before.
function WikiMetadataCard({ page }: { page: WikiPageData }) {
	const hasMetadata =
		Boolean(page.type) ||
		Boolean(page.status) ||
		page.tags.length > 0 ||
		page.owners.length > 0 ||
		Boolean(page.verified_at);
	if (!hasMetadata) return null;

	return (
		<div class="flex flex-wrap items-center gap-2 mb-4 p-3 border border-border rounded-lg bg-surface text-[0.8rem] text-text-muted">
			{page.type && (
				<span class="inline-flex items-center px-2 py-[0.1rem] rounded-full text-[0.72rem] font-semibold uppercase tracking-wide bg-bg border border-border text-text-muted">
					{page.type}
				</span>
			)}
			{page.status && <WikiStatusPill status={page.status} />}
			<TagChips tags={page.tags} />
			{page.owners.length > 0 && <span>Owners: {page.owners.join(", ")}</span>}
			{page.verified_at && (
				<span>
					Verified {new Date(page.verified_at * 1000).toLocaleDateString()}
					{page.verified_by ? ` by ${page.verified_by}` : ""}
				</span>
			)}
		</div>
	);
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
	slug?: string;
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

const TREE_ITEM_BASE_CLASS = [
	"block w-full text-left py-[0.375rem] px-2 rounded border-none cursor-pointer text-sm",
	"bg-transparent text-text-base hover:bg-border focus-visible:outline-2",
	"focus-visible:outline-accent focus-visible:outline-offset-2",
].join(" ");

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
				class={`${TREE_ITEM_BASE_CLASS} ${isActive ? "!bg-accent !text-white font-semibold" : ""}`}
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

// PROJ-486: search excerpts come back with `**match**` markers from the
// backend's FTS5 snippet() highlighting — split and render as <mark> instead
// of showing the literal asterisks.
function renderHighlightedExcerpt(excerpt: string) {
	const parts = excerpt.split(/(\*\*[^*]*\*\*)/g).filter((part) => part !== "");
	return parts.map((part, i) =>
		part.startsWith("**") && part.endsWith("**") ? (
			<mark key={i} class="bg-accent/30 text-inherit rounded-sm">
				{part.slice(2, -2)}
			</mark>
		) : (
			<span key={i}>{part}</span>
		)
	);
}

const SEARCH_RESULT_BUTTON_CLASS = [
	"block w-full text-left py-[0.375rem] px-2 rounded border-none cursor-pointer text-sm",
	"bg-transparent text-text-base hover:bg-border focus-visible:outline-2",
	"focus-visible:outline-accent focus-visible:outline-offset-2",
].join(" ");

function SearchResultsList({
	loading,
	results,
	onSelect,
}: {
	loading: boolean;
	results: SearchResult[];
	onSelect: (slug: string) => void;
}) {
	if (loading) return <p class="text-[0.8rem] text-text-muted m-0">Searching…</p>;
	if (results.length === 0) return <p class="text-[0.8rem] text-text-muted m-0">No results</p>;
	return (
		<ul class="list-none m-0 p-0">
			{results.map((r) => (
				<li key={r.id}>
					<button type="button" class={SEARCH_RESULT_BUTTON_CLASS} onClick={() => onSelect(r.slug)}>
						<span class="font-medium">{r.title}</span>
						{(r.type || r.status || (r.tags?.length ?? 0) > 0) && (
							<span class="block mt-[0.15rem]">
								{r.status && <WikiStatusPill status={r.status} />}
								<TagChips tags={r.tags} />
							</span>
						)}
						{r.excerpt && (
							<span class="block text-[0.75rem] text-text-muted truncate">
								{renderHighlightedExcerpt(r.excerpt)}
							</span>
						)}
					</button>
				</li>
			))}
		</ul>
	);
}

// PROJ-488: flat, non-hierarchical list shown in the sidebar when a type/status/tag
// filter is active — filtering the page *tree* (does any descendant match?) is out of
// scope for this ticket, so an active filter temporarily replaces the tree view instead
// of pruning it.
function FilteredPagesList({
	loading,
	results,
	onSelect,
}: {
	loading: boolean;
	results: WikiListItem[];
	onSelect: (slug: string) => void;
}) {
	if (loading) return <p class="text-[0.8rem] text-text-muted m-0">Loading…</p>;
	if (results.length === 0)
		return <p class="text-[0.8rem] text-text-muted m-0">No matching pages</p>;
	return (
		<ul class="list-none m-0 p-0">
			{results.map((r) => (
				<li key={r.id}>
					<button type="button" class={SEARCH_RESULT_BUTTON_CLASS} onClick={() => onSelect(r.slug)}>
						<span class="font-medium">{r.title}</span>
						{(r.type || r.status || (r.tags?.length ?? 0) > 0) && (
							<span class="block mt-[0.15rem]">
								{r.status && <WikiStatusPill status={r.status} />}
								<TagChips tags={r.tags} />
							</span>
						)}
					</button>
				</li>
			))}
		</ul>
	);
}

function PageTreeList({
	loading,
	tree,
	slug,
	onNavigate,
}: {
	loading: boolean;
	tree: TreeNode[];
	slug: string;
	onNavigate: (slug: string) => void;
}) {
	if (loading) return <p class="text-[0.8rem] text-text-muted m-0">Loading…</p>;
	return (
		<ul class="list-none m-0 p-0">
			{tree.map((node) => (
				<TreeNodeItem
					key={node.id}
					node={node}
					currentSlug={slug}
					depth={0}
					onNavigate={onNavigate}
				/>
			))}
			{tree.length === 0 && <li class="text-[0.8rem] text-text-muted">No pages yet</li>}
		</ul>
	);
}

// Lets a user viewing the workspace-wide wiki (or one project's wiki) switch to another
// scope explicitly, since the only other entry point is a project's nav tab. Switching
// scope is a full navigation (fresh tree/search for the new scope), not an in-place swap.
function useProjects(workspaceSlug: string | undefined) {
	const [projects, setProjects] = useState<ProjectOption[]>([]);

	useEffect(() => {
		apiFetch<ProjectOption[]>("/api/projects", { workspaceSlug })
			.then((list) => setProjects(Array.isArray(list) ? list : []))
			.catch(() => {});
	}, [workspaceSlug]);

	return projects;
}

function ScopeControl({
	workspaceSlug,
	projectId,
}: {
	workspaceSlug: string | undefined;
	projectId: string;
}) {
	const projects = useProjects(workspaceSlug);
	const options: SelectOption[] = [
		{ value: "", label: "Workspace (all projects)" },
		...projects.map((p) => ({ value: p.id, label: `${p.key} — ${p.name}` })),
	];

	return (
		<div class="mb-3">
			<p class="m-0 mb-1 text-[0.7rem] text-text-muted">Scope</p>
			<Select
				value={projectId}
				options={options}
				ariaLabel="Wiki project scope"
				onChange={(value) => {
					window.location.href = value ? `/wiki?projectId=${encodeURIComponent(value)}` : "/wiki";
				}}
			/>
		</div>
	);
}

// PROJ-488: type/status dropdowns + a comma-separated tags text filter, shared between
// the sidebar's filtered browse view and (via useWikiSearch) text search.
function WikiFilterBar({
	filterType,
	onFilterTypeChange,
	filterStatus,
	onFilterStatusChange,
	filterTags,
	onFilterTagsChange,
}: {
	filterType: string;
	onFilterTypeChange: (v: string) => void;
	filterStatus: string;
	onFilterStatusChange: (v: string) => void;
	filterTags: string;
	onFilterTagsChange: (v: string) => void;
}) {
	return (
		<div class="mb-3 flex flex-col gap-1.5">
			<Select
				value={filterType}
				options={WIKI_TYPE_FILTER_OPTIONS}
				ariaLabel="Filter wiki pages by type"
				onChange={onFilterTypeChange}
			/>
			<Select
				value={filterStatus}
				options={WIKI_STATUS_FILTER_OPTIONS}
				ariaLabel="Filter wiki pages by status"
				onChange={onFilterStatusChange}
			/>
			<input
				type="text"
				value={filterTags}
				onInput={(e) => onFilterTagsChange((e.target as HTMLInputElement).value)}
				placeholder="Filter by tags (comma-separated)…"
				class="w-full px-3 py-[0.375rem] border border-border rounded text-sm bg-bg text-text-base box-border"
				aria-label="Filter wiki pages by tags"
			/>
		</div>
	);
}

function WikiSidebar({
	workspaceSlug,
	projectId,
	searchQuery,
	onSearchQueryChange,
	searchResults,
	searchLoading,
	treeLoading,
	pageTree,
	slug,
	onNavigate,
	onCreate,
	filterType,
	onFilterTypeChange,
	filterStatus,
	onFilterStatusChange,
	filterTags,
	onFilterTagsChange,
	hasActiveFilters,
	filteredResults,
	filteredLoading,
}: {
	workspaceSlug: string | undefined;
	projectId: string;
	searchQuery: string;
	onSearchQueryChange: (value: string) => void;
	searchResults: SearchResult[];
	searchLoading: boolean;
	treeLoading: boolean;
	pageTree: TreeNode[];
	slug: string;
	onNavigate: (slug: string) => void;
	onCreate: () => void;
	filterType: string;
	onFilterTypeChange: (v: string) => void;
	filterStatus: string;
	onFilterStatusChange: (v: string) => void;
	filterTags: string;
	onFilterTagsChange: (v: string) => void;
	hasActiveFilters: boolean;
	filteredResults: WikiListItem[];
	filteredLoading: boolean;
}) {
	const asideClass = [
		"w-[240px] shrink-0 bg-surface border-r border-border p-4 overflow-y-auto",
		"max-sm:w-full max-sm:border-r-0 max-sm:border-b",
	].join(" ");
	return (
		<aside class={asideClass}>
			<ScopeControl workspaceSlug={workspaceSlug} projectId={projectId} />
			<button
				type="button"
				onClick={onCreate}
				class="btn btn-primary w-full mb-4 max-sm:min-h-[44px]"
			>
				+ New page
			</button>
			<input
				type="search"
				value={searchQuery}
				onInput={(e) => onSearchQueryChange((e.target as HTMLInputElement).value)}
				placeholder="Search pages…"
				class="w-full px-3 py-[0.375rem] mb-3 border border-border rounded text-sm bg-bg text-text-base box-border"
				aria-label="Search wiki pages"
			/>
			<WikiFilterBar
				filterType={filterType}
				onFilterTypeChange={onFilterTypeChange}
				filterStatus={filterStatus}
				onFilterStatusChange={onFilterStatusChange}
				filterTags={filterTags}
				onFilterTagsChange={onFilterTagsChange}
			/>
			{searchQuery.trim() ? (
				<SearchResultsList
					loading={searchLoading}
					results={searchResults}
					onSelect={(s) => {
						onSearchQueryChange("");
						onNavigate(s);
					}}
				/>
			) : hasActiveFilters ? (
				<FilteredPagesList
					loading={filteredLoading}
					results={filteredResults}
					onSelect={onNavigate}
				/>
			) : (
				<PageTreeList loading={treeLoading} tree={pageTree} slug={slug} onNavigate={onNavigate} />
			)}
		</aside>
	);
}

function CreatePageForm({
	parentTitle,
	title,
	slug,
	content,
	error,
	saving,
	onTitleChange,
	onSlugChange,
	onContentChange,
	onSubmit,
	onCancel,
}: {
	parentTitle: string | null;
	title: string;
	slug: string;
	content: string;
	error: string | null;
	saving: boolean;
	onTitleChange: (value: string) => void;
	onSlugChange: (value: string) => void;
	onContentChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) {
	return (
		<div>
			<h2 class="mb-6 text-2xl font-bold text-text-base">
				{parentTitle ? `New child page under "${parentTitle}"` : "New page"}
			</h2>
			{error && (
				<p role="alert" class="text-[var(--danger-text)] mb-3">
					{error}
				</p>
			)}
			<div class="mb-4">
				<label htmlFor="create-title" class="block font-medium text-sm text-text-base mb-1">
					Title <span class="text-[var(--danger-text)]">*</span>
				</label>
				<input
					id="create-title"
					type="text"
					value={title}
					onInput={(e) => onTitleChange((e.target as HTMLInputElement).value)}
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
					value={slug}
					onInput={(e) => onSlugChange((e.target as HTMLInputElement).value)}
					placeholder="auto-derived-from-title"
					class="w-full px-3 py-2 border border-border rounded text-sm bg-bg text-text-base box-border font-mono"
				/>
			</div>
			<div class="mb-5">
				{/* biome-ignore lint/a11y/noLabelWithoutControl: caption for MarkdownEditor, which has no associable control */}
				<label class="block font-medium text-sm text-text-base mb-1">Content (Markdown)</label>
				<MarkdownEditor value={content} onChange={onContentChange} minHeight="280px" />
			</div>
			<div class="flex gap-2">
				<button type="button" onClick={onSubmit} disabled={saving} class="btn btn-primary">
					{saving ? "Creating…" : "Create page"}
				</button>
				<button type="button" onClick={onCancel} disabled={saving} class="btn btn-outline">
					Cancel
				</button>
			</div>
		</div>
	);
}

const BREADCRUMB_BUTTON_CLASS = [
	"bg-transparent border-none cursor-pointer text-text-muted text-[0.8rem] p-0",
	"underline decoration-transparent hover:text-accent hover:decoration-accent",
].join(" ");

function PageBreadcrumbs({
	breadcrumbs,
	onNavigate,
}: {
	breadcrumbs: FlatEntry[];
	onNavigate: (slug: string) => void;
}) {
	if (breadcrumbs.length <= 1) return null;
	return (
		<nav
			class="wiki-breadcrumb text-[0.8rem] text-text-muted mb-3 flex flex-wrap gap-1 items-center"
			aria-label="Breadcrumb"
		>
			<button
				type="button"
				class={BREADCRUMB_BUTTON_CLASS}
				onClick={() => onNavigate(breadcrumbs[0].slug)}
			>
				Home
			</button>
			{breadcrumbs.slice(1, -1).map((crumb) => (
				<>
					<span>›</span>
					<button
						key={crumb.id}
						type="button"
						class={BREADCRUMB_BUTTON_CLASS}
						onClick={() => onNavigate(crumb.slug)}
					>
						{crumb.title}
					</button>
				</>
			))}
			<span>›</span>
			<span class="text-text-base">{breadcrumbs[breadcrumbs.length - 1].title}</span>
		</nav>
	);
}

function MovePageForm({
	options,
	value,
	saving,
	error,
	onChange,
	onSubmit,
	onCancel,
}: {
	options: SelectOption[];
	value: string;
	saving: boolean;
	error: string | null;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) {
	return (
		<div class="mb-4 p-3 border border-border rounded bg-surface">
			<p class="m-0 mb-2 text-sm font-medium text-text-base">Move to a new parent page</p>
			{error && (
				<p role="alert" class="text-[var(--danger-text)] mb-2 text-sm">
					{error}
				</p>
			)}
			<div class="flex flex-wrap gap-2 items-center">
				<div class="min-w-[220px]">
					<Select value={value} options={options} ariaLabel="New parent page" onChange={onChange} />
				</div>
				<button type="button" onClick={onSubmit} disabled={saving} class="btn btn-primary btn-sm">
					{saving ? "Moving…" : "Move"}
				</button>
				<button type="button" onClick={onCancel} disabled={saving} class="btn btn-outline btn-sm">
					Cancel
				</button>
			</div>
		</div>
	);
}

const TOC_LINK_BASE_CLASS =
	"block py-[0.2rem] no-underline border-l-2 transition-[color,border-color] duration-150";
const TOC_LINK_ACTIVE_CLASS = "text-accent border-accent font-medium";
const TOC_LINK_INACTIVE_CLASS =
	"text-text-muted border-border hover:text-accent hover:border-accent";

function TocList({
	toc,
	activeHeadingId,
	onClick,
}: {
	toc: TocItem[];
	activeHeadingId: string;
	onClick?: () => void;
}) {
	return (
		<>
			{toc.map((item) => {
				const isTocActive = activeHeadingId === item.id;
				return (
					<a
						key={item.id}
						href={`#${item.id}`}
						class={`${TOC_LINK_BASE_CLASS} ${isTocActive ? TOC_LINK_ACTIVE_CLASS : TOC_LINK_INACTIVE_CLASS}`}
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

function PageHeader({
	editing,
	pageId,
	title,
	editTitle,
	onEditTitleChange,
	saving,
	onSave,
	onCancelEdit,
	onStartEdit,
	onStartCreateChild,
	onStartMove,
	onDelete,
}: {
	editing: boolean;
	pageId: string;
	title: string;
	editTitle: string;
	onEditTitleChange: (value: string) => void;
	saving: boolean;
	onSave: () => void;
	onCancelEdit: () => void;
	onStartEdit: () => void;
	onStartCreateChild: (pageId: string) => void;
	onStartMove: () => void;
	onDelete: () => void;
}) {
	return (
		<header class="flex items-start justify-between gap-4 mb-1">
			{editing ? (
				<input
					id="wiki-title"
					type="text"
					value={editTitle}
					onInput={(e) => onEditTitleChange((e.target as HTMLInputElement).value)}
					aria-label="Page title"
					class="flex-1 px-3 py-2 border border-border rounded text-sm bg-bg text-text-base box-border text-2xl font-bold"
				/>
			) : (
				<h1 class="m-0 text-[1.75rem] font-bold text-text-base">{title}</h1>
			)}

			<div class="flex gap-2 shrink-0">
				{editing ? (
					<>
						<button type="button" onClick={onSave} disabled={saving} class="btn btn-primary">
							{saving ? "Saving…" : "Save"}
						</button>
						<button type="button" onClick={onCancelEdit} disabled={saving} class="btn btn-outline">
							Cancel
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={() => onStartCreateChild(pageId)}
							class="btn btn-outline btn-sm"
						>
							+ Child page
						</button>
						<button type="button" onClick={onStartMove} class="btn btn-outline btn-sm">
							Move
						</button>
						<button type="button" onClick={onStartEdit} class="btn btn-outline">
							Edit
						</button>
						<button type="button" onClick={onDelete} class="btn btn-danger">
							Delete
						</button>
					</>
				)}
			</div>
		</header>
	);
}

function DraftRestoreBanner({
	savedAt,
	onRestore,
	onDiscard,
}: {
	savedAt: number;
	onRestore: () => void;
	onDiscard: () => void;
}) {
	const bannerClass = [
		"mb-3 px-3 py-2 border border-border rounded bg-surface text-sm flex items-center",
		"justify-between gap-3 flex-wrap",
	].join(" ");
	return (
		<div class={bannerClass}>
			<span>Restore unsaved draft from {new Date(savedAt).toLocaleString()}?</span>
			<div class="flex gap-2 shrink-0">
				<button type="button" onClick={onRestore} class="btn btn-primary btn-sm">
					Restore
				</button>
				<button type="button" onClick={onDiscard} class="btn btn-outline btn-sm">
					Discard
				</button>
			</div>
		</div>
	);
}

function RevisionsHistory({
	revisions,
	showHistory,
	onToggle,
}: {
	revisions: WikiRevision[];
	showHistory: boolean;
	onToggle: () => void;
}) {
	if (revisions.length === 0) return null;
	return (
		<div class="mt-8">
			<button type="button" onClick={onToggle} class="btn btn-outline btn-sm text-text-muted">
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
	);
}

function AttachmentEntry({
	attachment,
	workspaceSlug,
	onDelete,
}: {
	attachment: Attachment;
	workspaceSlug?: string;
	onDelete: (attachmentId: string) => void;
}) {
	const qs = workspaceSlug ? `?workspace=${workspaceSlug}` : "";
	return (
		<div class="flex items-center gap-3 px-3 py-2 border border-border rounded-md bg-surface">
			<a
				href={`/api/files/${attachment.id}${qs}`}
				target="_blank"
				rel="noreferrer"
				class="text-accent text-sm no-underline hover:underline flex-1 min-w-0 truncate"
			>
				{attachment.filename}
			</a>
			<span class="text-xs text-text-muted shrink-0">{formatBytes(attachment.size)}</span>
			<button
				type="button"
				onClick={() => onDelete(attachment.id)}
				aria-label={`Delete ${attachment.filename}`}
				class="btn btn-sm bg-transparent border-none text-text-muted px-[0.125rem] leading-none"
			>
				×
			</button>
		</div>
	);
}

function AttachmentUploadForm({
	uploadFile,
	uploading,
	uploadError,
	onFileChange,
	onUpload,
	onCancel,
}: {
	uploadFile: File | null;
	uploading: boolean;
	uploadError: string | null;
	onFileChange: (file: File | null) => void;
	onUpload: () => void;
	onCancel: () => void;
}) {
	return (
		<div class="flex flex-wrap gap-2 items-center">
			<label class="relative cursor-pointer">
				<input
					type="file"
					class="sr-only"
					onChange={(e) => onFileChange((e.target as HTMLInputElement).files?.[0] ?? null)}
				/>
				<span class="btn btn-outline btn-sm">{uploadFile ? uploadFile.name : "Choose file"}</span>
			</label>
			<button
				type="button"
				onClick={onUpload}
				disabled={!uploadFile || uploading}
				class="btn btn-primary"
			>
				{uploading ? "Uploading…" : "Upload"}
			</button>
			<button type="button" onClick={onCancel} class="btn btn-outline">
				Cancel
			</button>
			{uploadError && (
				<span role="alert" class="text-[0.8rem] text-[var(--danger-text)] self-center">
					{uploadError}
				</span>
			)}
		</div>
	);
}

function AttachmentsPanel({
	attachments,
	workspaceSlug,
	uploadFormOpen,
	uploadFile,
	uploading,
	uploadError,
	onToggleUploadForm,
	onFileChange,
	onUpload,
	onCancelUpload,
	onDeleteAttachment,
}: {
	attachments: Attachment[];
	workspaceSlug?: string;
	uploadFormOpen: boolean;
	uploadFile: File | null;
	uploading: boolean;
	uploadError: string | null;
	onToggleUploadForm: (open: boolean) => void;
	onFileChange: (file: File | null) => void;
	onUpload: () => void;
	onCancelUpload: () => void;
	onDeleteAttachment: (attachmentId: string) => void;
}) {
	return (
		<div class="mt-8">
			<h3 class="text-xs uppercase tracking-[0.05em] text-text-muted font-semibold mb-3 pb-2 border-b border-border">
				{`Attachments${attachments.length > 0 ? ` (${attachments.length})` : ""}`}
			</h3>

			{attachments.length > 0 && (
				<div class="mb-4 flex flex-col gap-2">
					{attachments.map((a) => (
						<AttachmentEntry
							key={a.id}
							attachment={a}
							workspaceSlug={workspaceSlug}
							onDelete={onDeleteAttachment}
						/>
					))}
				</div>
			)}

			{uploadFormOpen ? (
				<AttachmentUploadForm
					uploadFile={uploadFile}
					uploading={uploading}
					uploadError={uploadError}
					onFileChange={onFileChange}
					onUpload={onUpload}
					onCancel={onCancelUpload}
				/>
			) : (
				<button
					type="button"
					onClick={() => onToggleUploadForm(true)}
					class="text-sm text-text-muted hover:text-text-base transition-colors flex items-center gap-1"
				>
					<span class="text-base leading-none">+</span>
					<span>Attach file</span>
				</button>
			)}
		</div>
	);
}

interface PageArticleProps {
	page: WikiPageData;
	breadcrumbs: FlatEntry[];
	onNavigate: (slug: string) => void;
	showToc: boolean;
	toc: TocItem[];
	activeHeadingId: string;
	contentRef: RefObject<HTMLDivElement>;
	editing: boolean;
	editTitle: string;
	onEditTitleChange: (value: string) => void;
	saving: boolean;
	onSave: () => void;
	onCancelEdit: () => void;
	onStartEdit: () => void;
	onStartCreateChild: (pageId: string) => void;
	onDelete: () => void;
	moving: boolean;
	moveOptions: SelectOption[];
	moveTargetId: string;
	moveSaving: boolean;
	moveError: string | null;
	onStartMove: () => void;
	onMoveTargetChange: (value: string) => void;
	onSubmitMove: () => void;
	onCancelMove: () => void;
	latestRevision: WikiRevision | null;
	saveError: string | null;
	draftBanner: { title: string; content: string; savedAt: number } | null;
	onRestoreDraft: () => void;
	onDiscardDraft: () => void;
	editContent: string;
	onEditContentChange: (value: string) => void;
	wikiPages: FlatEntry[];
	revisions: WikiRevision[];
	showHistory: boolean;
	onToggleHistory: () => void;
	attachments: Attachment[];
	workspaceSlug?: string;
	uploadFormOpen: boolean;
	uploadFile: File | null;
	uploading: boolean;
	uploadError: string | null;
	onToggleUploadForm: (open: boolean) => void;
	onFileChange: (file: File | null) => void;
	onUpload: () => void;
	onCancelUpload: () => void;
	onDeleteAttachment: (attachmentId: string) => void;
}

function PageArticleMeta(
	props: Pick<
		PageArticleProps,
		| "page"
		| "breadcrumbs"
		| "onNavigate"
		| "showToc"
		| "toc"
		| "activeHeadingId"
		| "editing"
		| "editTitle"
		| "onEditTitleChange"
		| "saving"
		| "onSave"
		| "onCancelEdit"
		| "onStartEdit"
		| "onStartCreateChild"
		| "onDelete"
		| "moving"
		| "moveOptions"
		| "moveTargetId"
		| "moveSaving"
		| "moveError"
		| "onStartMove"
		| "onMoveTargetChange"
		| "onSubmitMove"
		| "onCancelMove"
		| "latestRevision"
		| "saveError"
		| "draftBanner"
		| "onRestoreDraft"
		| "onDiscardDraft"
	>
) {
	return (
		<>
			<PageBreadcrumbs breadcrumbs={props.breadcrumbs} onNavigate={props.onNavigate} />

			{props.showToc && (
				<details class="mb-4 max-[900px]:block min-[901px]:hidden">
					<summary class="cursor-pointer text-[0.8rem] text-text-muted select-none">
						Contents ({props.toc.length})
					</summary>
					<div class="pt-2">
						<TocList toc={props.toc} activeHeadingId={props.activeHeadingId} />
					</div>
				</details>
			)}

			<PageHeader
				editing={props.editing}
				pageId={props.page.id}
				title={props.page.title}
				editTitle={props.editTitle}
				onEditTitleChange={props.onEditTitleChange}
				saving={props.saving}
				onSave={props.onSave}
				onCancelEdit={props.onCancelEdit}
				onStartEdit={props.onStartEdit}
				onStartCreateChild={props.onStartCreateChild}
				onStartMove={props.onStartMove}
				onDelete={props.onDelete}
			/>

			{!props.editing && <WikiMetadataCard page={props.page} />}

			{props.moving && (
				<MovePageForm
					options={props.moveOptions}
					value={props.moveTargetId}
					saving={props.moveSaving}
					error={props.moveError}
					onChange={props.onMoveTargetChange}
					onSubmit={props.onSubmitMove}
					onCancel={props.onCancelMove}
				/>
			)}

			{props.latestRevision && (
				<p class="text-[0.8rem] text-text-muted mt-1 mb-5">
					Last edited by{" "}
					<strong class="text-text-base">{props.latestRevision.author_name ?? "Unknown"}</strong> at{" "}
					{new Date(props.latestRevision.created_at * 1000).toLocaleString()}
				</p>
			)}

			{props.saveError && (
				<p role="alert" class="text-[var(--danger-text)] mb-3">
					{props.saveError}
				</p>
			)}

			{props.editing && props.draftBanner && (
				<DraftRestoreBanner
					savedAt={props.draftBanner.savedAt}
					onRestore={props.onRestoreDraft}
					onDiscard={props.onDiscardDraft}
				/>
			)}
		</>
	);
}

function PageArticle(props: PageArticleProps) {
	const { page } = props;
	return (
		<div class="flex gap-8 items-start">
			<article class="flex-1 min-w-0">
				<PageArticleMeta {...props} />

				{props.editing ? (
					<div class="mb-3">
						<MarkdownEditor
							value={props.editContent}
							onChange={props.onEditContentChange}
							minHeight="320px"
						/>
					</div>
				) : (
					<div
						ref={props.contentRef}
						class="prose prose-sm max-w-none"
						dangerouslySetInnerHTML={{
							__html: renderMdWithWikilinks(stripFrontmatter(page.content), props.wikiPages),
						}}
					/>
				)}

				<RevisionsHistory
					revisions={props.revisions}
					showHistory={props.showHistory}
					onToggle={props.onToggleHistory}
				/>

				<AttachmentsPanel
					attachments={props.attachments}
					workspaceSlug={props.workspaceSlug}
					uploadFormOpen={props.uploadFormOpen}
					uploadFile={props.uploadFile}
					uploading={props.uploading}
					uploadError={props.uploadError}
					onToggleUploadForm={props.onToggleUploadForm}
					onFileChange={props.onFileChange}
					onUpload={props.onUpload}
					onCancelUpload={props.onCancelUpload}
					onDeleteAttachment={props.onDeleteAttachment}
				/>

				<footer class="mt-8 pt-4 border-t border-border text-xs text-text-muted">
					Last updated: {new Date(page.updated_at * 1000).toLocaleString()}
				</footer>
			</article>

			{props.showToc && (
				<nav
					class={[
						"w-[190px] shrink-0 sticky top-6 self-start max-h-[calc(100vh-3rem)]",
						"overflow-y-auto text-[0.8rem] max-[900px]:hidden",
					].join(" ")}
					aria-label="Table of contents"
				>
					<h3 class="m-0 mb-2 text-xs uppercase tracking-[0.05em] text-text-muted font-semibold">
						Contents
					</h3>
					<TocList toc={props.toc} activeHeadingId={props.activeHeadingId} />
				</nav>
			)}
		</div>
	);
}

interface CreateFormProps {
	parentTitle: string | null;
	title: string;
	slug: string;
	content: string;
	error: string | null;
	saving: boolean;
	onTitleChange: (value: string) => void;
	onSlugChange: (value: string) => void;
	onContentChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
}

function WikiMainContent(props: {
	creating: boolean;
	createProps: CreateFormProps;
	slug: string;
	loading: boolean;
	error: string | null;
	page: WikiPageData | null;
	articleProps: Omit<PageArticleProps, "page">;
}) {
	if (props.creating) return <CreatePageForm {...props.createProps} />;
	if (!props.slug) {
		return <p class="text-text-muted">Select a page from the sidebar or create a new one.</p>;
	}
	if (props.loading) return <p aria-live="polite">Loading…</p>;
	if (props.error) {
		// PROJ-487: a slug that resolves to nothing (not even via a PROJ-483 redirect)
		// gets a dedicated 404 message rather than the generic failure text.
		if (props.error.includes("404")) {
			return (
				<p role="alert" class="text-text-muted">
					No wiki page found at "{props.slug}".
				</p>
			);
		}
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load page: {props.error}
			</p>
		);
	}
	if (!props.page) return null;
	return <PageArticle {...props.articleProps} page={props.page} />;
}

// PROJ-487: /wiki/:slug is now the canonical path. `slugProp` covers the astro
// dynamic route (dev server); `view.astro` (the production pretty-URL shell served
// via the Worker fallback, see apps/api/src/index.ts) has no such param, so this
// also falls back to parsing the slug straight out of the path, matching the
// convention IssueDetail already uses for /projects/:key/issues/:n/*.
function slugFromPathname(pathname: string): string {
	const match = /^\/wiki\/([^/]+)\/?$/.exec(pathname);
	return match ? decodeURIComponent(match[1]) : "";
}

function useWikiUrlState(projectIdProp: string | undefined, slugProp: string | undefined) {
	const [slug, setSlug] = useState(slugProp ?? "");
	const [projectId, setProjectId] = useState(projectIdProp ?? "");

	useEffect(() => {
		if (!slugProp) {
			const params = new URLSearchParams(window.location.search);
			// ?slug= is the legacy PROJ-307 query form. Kept as a fallback (not just for
			// the redirect below) so an old bookmark/link still resolves even if the
			// redirect effect hasn't run yet.
			setSlug(params.get("slug") || slugFromPathname(window.location.pathname));
		}
		if (!projectIdProp)
			setProjectId(new URLSearchParams(window.location.search).get("projectId") ?? "");
	}, [projectIdProp, slugProp]);

	return { slug, setSlug, projectId };
}

// PROJ-487: /wiki?slug=X (and stale slugs that PROJ-483 redirects) get sent to the
// canonical /wiki/:slug path client-side — this build is static output (no per-request
// server rendering, see AGENTS.md's release-artifact constraint), so a real HTTP 301
// isn't available here; this is the closest equivalent. `fetchedSlug` is the page's
// *current* slug from the API response, so a rename redirects straight to the new
// canonical path instead of chaining through the old one.
function useLegacyQuerySlugRedirect(fetchedSlug: string | undefined, requestedSlug: string) {
	useEffect(() => {
		if (!fetchedSlug) return;
		const params = new URLSearchParams(window.location.search);
		const hasLegacyQuery = params.has("slug");
		const onCanonicalPath = window.location.pathname === `/wiki/${encodeURIComponent(fetchedSlug)}`;
		if ((hasLegacyQuery || fetchedSlug !== requestedSlug) && !onCanonicalPath) {
			window.location.replace(`/wiki/${encodeURIComponent(fetchedSlug)}`);
		}
	}, [fetchedSlug, requestedSlug]);
}

function useWikiTree(workspaceSlug: string | undefined, projectId: string) {
	const [pageTree, setPageTree] = useState<TreeNode[]>([]);
	const [pageMap, setPageMap] = useState<Record<string, FlatEntry>>({});
	const [treeLoading, setTreeLoading] = useState(false);

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

	return { pageTree, pageMap, treeLoading, fetchTree };
}

// PROJ-488: type/status/tags filters shared between the sidebar's filtered browse view
// (no search query — a flat list from listWikiPages) and text search below (combined
// with the FTS query via search_wiki's own type/status/tags params).
function useWikiFilters(workspaceSlug: string | undefined, projectId: string) {
	const [filterType, setFilterType] = useState("");
	const [filterStatus, setFilterStatus] = useState("");
	const [filterTags, setFilterTags] = useState("");
	const [filteredResults, setFilteredResults] = useState<WikiListItem[]>([]);
	const [filteredLoading, setFilteredLoading] = useState(false);

	const hasActiveFilters = Boolean(filterType || filterStatus || filterTags.trim());

	useEffect(() => {
		if (!hasActiveFilters) {
			setFilteredResults([]);
			return;
		}
		setFilteredLoading(true);
		const timer = setTimeout(async () => {
			try {
				const qs = new URLSearchParams();
				if (projectId) qs.set("projectId", projectId);
				if (filterType) qs.set("type", filterType);
				if (filterStatus) qs.set("status", filterStatus);
				if (filterTags.trim()) qs.set("tags", filterTags);
				const data = await apiFetch<WikiListItem[]>(`/api/wiki?${qs}`, { workspaceSlug });
				setFilteredResults(Array.isArray(data) ? data : []);
			} catch {
				// non-fatal
			} finally {
				setFilteredLoading(false);
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [filterType, filterStatus, filterTags, workspaceSlug, projectId, hasActiveFilters]);

	return {
		filterType,
		setFilterType,
		filterStatus,
		setFilterStatus,
		filterTags,
		setFilterTags,
		filteredResults,
		filteredLoading,
		hasActiveFilters,
	};
}

function useWikiSearch(
	workspaceSlug: string | undefined,
	projectId: string,
	filters: { filterType: string; filterStatus: string; filterTags: string }
) {
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
	const [searchLoading, setSearchLoading] = useState(false);
	const { filterType, filterStatus, filterTags } = filters;

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
				if (filterType) qs.set("type", filterType);
				if (filterStatus) qs.set("status", filterStatus);
				if (filterTags.trim()) qs.set("tags", filterTags);
				const data = await apiFetch<SearchResult[]>(`/api/wiki/search?${qs}`, { workspaceSlug });
				setSearchResults(Array.isArray(data) ? data : []);
			} catch {
				// non-fatal
			} finally {
				setSearchLoading(false);
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery, workspaceSlug, projectId, filterType, filterStatus, filterTags]);

	return { searchQuery, setSearchQuery, searchResults, searchLoading };
}

function useWikiPageData(workspaceSlug: string | undefined, slug: string) {
	const [page, setPage] = useState<WikiPageData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revisions, setRevisions] = useState<WikiRevision[]>([]);
	// PROJ-507: whether `revisions` reflects a completed fetch for this page. An empty
	// list means two very different things to the optimistic lock — "this page has never
	// been revised" (baseRevisionId: null) vs "we don't know yet" — and conflating them
	// makes a legitimate save look like a conflict.
	const [revisionsLoaded, setRevisionsLoaded] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	const fetchPage = useCallback(
		async (s: string) => {
			if (!s) return;
			setLoading(true);
			setError(null);
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
					{
						workspaceSlug,
					}
				);
				setRevisions(Array.isArray(data) ? data : []);
				setRevisionsLoaded(true);
			} catch {
				// non-fatal
			}
		},
		[workspaceSlug]
	);

	// Revisions belong to the page the `slug` prop points at, so they're reset when it
	// changes — not on every fetchPage(), which also runs as a same-page refresh (after
	// a save or a move) and would leave the list empty until something refetched it.
	useEffect(() => {
		setRevisions([]);
		setRevisionsLoaded(false);
		setShowHistory(false);
		if (slug) {
			fetchPage(slug);
			fetchRevisions(slug);
		}
	}, [slug, fetchPage, fetchRevisions]);

	return {
		page,
		setPage,
		loading,
		error,
		setError,
		revisions,
		revisionsLoaded,
		fetchRevisions,
		showHistory,
		setShowHistory,
		contentRef,
		fetchPage,
	};
}

function setMetaTag(attr: "name" | "property", key: string, content: string) {
	let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
	if (!el) {
		el = document.createElement("meta");
		el.setAttribute(attr, key);
		document.head.appendChild(el);
	}
	el.setAttribute("content", content);
}

function excerptOf(content: string, maxLength = 200): string {
	// PROJ-488: never let a page's frontmatter YAML become its og:description.
	const plain = stripFrontmatter(content)
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#*_>`[\]()!-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > maxLength ? `${plain.slice(0, maxLength).trimEnd()}…` : plain;
}

// PROJ-487: the static build (see AGENTS.md) can't render per-page <title>/OG tags
// on the server — there's no per-request render step to do it in — so this updates
// them client-side once the page has loaded, the closest approximation available.
function useWikiPageMeta(page: WikiPageData | null) {
	useEffect(() => {
		if (!page) return;
		document.title = `${page.title} — Projektor Wiki`;
		setMetaTag("property", "og:title", page.title);
		setMetaTag("property", "og:description", excerptOf(page.content));
		setMetaTag(
			"property",
			"og:url",
			`${window.location.origin}/wiki/${encodeURIComponent(page.slug)}`
		);
	}, [page]);
}

function useTableOfContents(page: WikiPageData | null, contentRef: RefObject<HTMLDivElement>) {
	const [toc, setToc] = useState<TocItem[]>([]);
	const [activeHeadingId, setActiveHeadingId] = useState("");

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

	return { toc, setToc, activeHeadingId };
}

function useWikiAttachments(workspaceSlug: string | undefined, page: WikiPageData | null) {
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [uploadFormOpen, setUploadFormOpen] = useState(false);
	const [uploadFile, setUploadFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);

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
		if (page?.id) fetchAttachments(page.id);
	}, [page?.id, fetchAttachments]);

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

	function cancelUpload() {
		setUploadFormOpen(false);
		setUploadFile(null);
		setUploadError(null);
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

	return {
		attachments,
		uploadFormOpen,
		setUploadFormOpen,
		uploadFile,
		setUploadFile,
		uploading,
		uploadError,
		uploadAttachment,
		cancelUpload,
		deleteAttachment,
	};
}

function useDraftAutosave(
	editing: boolean,
	editTitle: string,
	editContent: string,
	page: WikiPageData | null,
	draftBanner: { title: string; content: string; savedAt: number } | null
) {
	// Latest edit state for the flush-on-leave effect below, since its cleanup
	// closure would otherwise only see the values from when `editing` last changed.
	const latestDraftStateRef = useRef({ editTitle, editContent, page, draftBanner });
	latestDraftStateRef.current = { editTitle, editContent, page, draftBanner };

	// save() clears the draft itself right before leaving edit mode; set this to
	// suppress the flush below so it doesn't resurrect the just-cleared draft.
	const skipLeaveFlushRef = useRef(false);

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

	return skipLeaveFlushRef;
}

function useWikiEditing(
	workspaceSlug: string | undefined,
	page: WikiPageData | null,
	fetchPage: (s: string) => Promise<void>,
	fetchRevisions: (s: string) => Promise<void>,
	latestRevisionId: string | null | undefined
) {
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
	// PROJ-507: the revision id of the content the user actually started editing,
	// frozen at startEdit() time — sent back as baseRevisionId so the server can
	// detect a concurrent edit landing between load and save (PROJ-484's optimistic
	// lock). Using the live `latestRevisionId` at save time instead would defeat the
	// check, since it tracks whatever the page's latest revision is *right now*.
	// `undefined` (revisions not loaded when editing started) omits the field, which
	// the server treats as the transitional last-write-wins path — sending `null` there
	// would instead assert "this page has no revisions" and fail every save.
	const [baseRevisionId, setBaseRevisionId] = useState<string | null | undefined>(undefined);

	const skipLeaveFlushRef = useDraftAutosave(editing, editTitle, editContent, page, draftBanner);

	function startEdit() {
		if (!page) return;
		setSaveError(null);
		setDraftBanner(null);
		setBaseRevisionId(latestRevisionId);
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
				body: { title: editTitle, content: editContent, baseRevisionId },
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
			// PROJ-507: a 409 means someone else saved this page after we loaded it
			// (PROJ-484's optimistic lock rejected our stale baseRevisionId) — surface
			// that distinctly rather than the generic failure message, so the user
			// knows to reload instead of retrying the same save.
			// Match the tail of apiFetch's message, not a bare "409" — the request path is
			// part of it, and slugs like "proj-409-notes" would otherwise read as conflicts.
			if (String(e).endsWith("failed: 409")) {
				setSaveError(
					"This page was changed by someone else since you loaded it. Reload the page before saving to avoid overwriting their changes."
				);
			} else {
				setSaveError(`Save failed: ${String(e)}`);
			}
		} finally {
			setSaving(false);
		}
	}

	return {
		editing,
		setEditing,
		editTitle,
		setEditTitle,
		editContent,
		setEditContent,
		saving,
		saveError,
		draftBanner,
		startEdit,
		restoreDraft,
		discardDraft,
		cancelEdit,
		save,
	};
}

// PROJ-237: re-parent a page from the page menu. Backend validation (cycle guard,
// workspace scoping) already exists on PUT /api/wiki/:slug — this is UI-only.
function useMovePage(
	workspaceSlug: string | undefined,
	page: WikiPageData | null,
	fetchPage: (s: string) => Promise<void>,
	fetchTree: () => Promise<void>
) {
	const [moving, setMoving] = useState(false);
	const [moveTargetId, setMoveTargetId] = useState("");
	const [moveSaving, setMoveSaving] = useState(false);
	const [moveError, setMoveError] = useState<string | null>(null);

	function startMove() {
		if (!page) return;
		setMoveTargetId(page.parent_id ?? "");
		setMoveError(null);
		setMoving(true);
	}

	function cancelMove() {
		setMoving(false);
		setMoveError(null);
	}

	async function submitMove() {
		if (!page) return;
		setMoveSaving(true);
		setMoveError(null);
		try {
			await apiFetch(`/api/wiki/${encodeURIComponent(page.slug)}`, {
				method: "PUT",
				workspaceSlug,
				body: { parentId: moveTargetId || null },
			});
			setMoving(false);
			await fetchTree();
			await fetchPage(page.slug);
		} catch (e) {
			setMoveError(`Move failed: ${String(e)}`);
		} finally {
			setMoveSaving(false);
		}
	}

	return {
		moving,
		moveTargetId,
		setMoveTargetId,
		moveSaving,
		moveError,
		startMove,
		cancelMove,
		submitMove,
	};
}

function useCreatePageForm(
	workspaceSlug: string | undefined,
	projectId: string,
	fetchTree: () => Promise<void>
) {
	const [creating, setCreating] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createSlug, setCreateSlug] = useState("");
	const [createContent, setCreateContent] = useState("");
	const [createParentId, setCreateParentId] = useState<string | null>(null);
	const [createError, setCreateError] = useState<string | null>(null);
	const [createSaving, setCreateSaving] = useState(false);
	const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

	useEffect(() => {
		const prefilledTitle = new URLSearchParams(window.location.search).get("createTitle");
		if (prefilledTitle) {
			setCreating(true);
			setCreateTitle(prefilledTitle);
			setCreateSlug(slugify(prefilledTitle));
		}
	}, []);

	function startCreate(parentId: string | null = null) {
		setCreating(true);
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

	function onCreateTitleChange(v: string) {
		setCreateTitle(v);
		if (!slugManuallyEdited) setCreateSlug(slugify(v));
	}

	function onCreateSlugChange(v: string) {
		setCreateSlug(v);
		setSlugManuallyEdited(true);
	}

	async function submitCreate(): Promise<string | undefined> {
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
			return created.slug;
		} catch (e) {
			setCreateError(`Create failed: ${String(e)}`);
		} finally {
			setCreateSaving(false);
		}
	}

	return {
		creating,
		setCreating,
		createTitle,
		createSlug,
		createContent,
		setCreateContent,
		createParentId,
		createError,
		createSaving,
		startCreate,
		cancelCreate,
		onCreateTitleChange,
		onCreateSlugChange,
		submitCreate,
	};
}

function createWikiActions(args: {
	workspaceSlug: string | undefined;
	page: WikiPageData | null;
	fetchTree: () => Promise<void>;
	setSlug: (s: string) => void;
	setCreating: (v: boolean) => void;
	setEditing: (v: boolean) => void;
	setPage: (p: WikiPageData | null) => void;
	setError: (e: string | null) => void;
	setToc: (t: TocItem[]) => void;
	rawStartCreate: (parentId: string | null) => void;
	rawSubmitCreate: () => Promise<string | undefined>;
	cancelMove: () => void;
}) {
	const {
		workspaceSlug,
		page,
		fetchTree,
		setSlug,
		setCreating,
		setEditing,
		setPage,
		setError,
		setToc,
		cancelMove,
	} = args;

	function navigateTo(s: string) {
		setCreating(false);
		setEditing(false);
		setPage(null);
		setError(null);
		setToc([]);
		setSlug(s);
		cancelMove();
		history.pushState(null, "", s ? `/wiki/${encodeURIComponent(s)}` : "/wiki");
	}

	function startCreate(parentId: string | null = null) {
		setEditing(false);
		args.cancelMove();
		args.rawStartCreate(parentId);
	}

	async function submitCreate() {
		const createdSlug = await args.rawSubmitCreate();
		if (createdSlug) navigateTo(createdSlug);
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
			history.pushState(null, "", "/wiki");
			await fetchTree();
		} catch (e) {
			alert(`Delete failed: ${String(e)}`);
		}
	}

	return { navigateTo, startCreate, submitCreate, deletePage };
}

const WIKI_PAGE_STYLES = `
	.wiki-link-broken {
		color: var(--text-muted);
		text-decoration: underline;
		text-decoration-style: dashed;
		text-underline-offset: 2px;
	}
	.wiki-link-broken a {
		font-size: 0.8em;
		margin-left: 0.2em;
		color: var(--text-muted);
		text-decoration: none;
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0 3px;
	}
	.wiki-link-broken a:hover {
		color: var(--accent);
		border-color: var(--accent);
	}
	.prose pre.mermaid {
		display: flex;
		justify-content: center;
		background: none;
		padding: 0;
	}
	.prose pre.mermaid svg {
		max-width: 100%;
		width: auto;
		height: auto;
	}
	@media (max-width: 640px) {
		.wiki-breadcrumb button {
			max-width: 8rem;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
	}
`;

function WikiPageShell(props: {
	workspaceSlug: string | undefined;
	projectId: string;
	searchQuery: string;
	onSearchQueryChange: (v: string) => void;
	searchResults: SearchResult[];
	searchLoading: boolean;
	treeLoading: boolean;
	pageTree: TreeNode[];
	slug: string;
	onNavigate: (slug: string) => void;
	onCreate: () => void;
	filters: ReturnType<typeof useWikiFilters>;
	mainContentProps: {
		creating: boolean;
		createProps: CreateFormProps;
		slug: string;
		loading: boolean;
		error: string | null;
		page: WikiPageData | null;
		articleProps: Omit<PageArticleProps, "page">;
	};
}) {
	return (
		<div class="flex min-h-screen max-sm:flex-col">
			<style>{WIKI_PAGE_STYLES}</style>
			<WikiSidebar
				workspaceSlug={props.workspaceSlug}
				projectId={props.projectId}
				searchQuery={props.searchQuery}
				onSearchQueryChange={props.onSearchQueryChange}
				searchResults={props.searchResults}
				searchLoading={props.searchLoading}
				treeLoading={props.treeLoading}
				pageTree={props.pageTree}
				slug={props.slug}
				onNavigate={props.onNavigate}
				onCreate={props.onCreate}
				filterType={props.filters.filterType}
				onFilterTypeChange={props.filters.setFilterType}
				filterStatus={props.filters.filterStatus}
				onFilterStatusChange={props.filters.setFilterStatus}
				filterTags={props.filters.filterTags}
				onFilterTagsChange={props.filters.setFilterTags}
				hasActiveFilters={props.filters.hasActiveFilters}
				filteredResults={props.filters.filteredResults}
				filteredLoading={props.filters.filteredLoading}
			/>

			<main class="flex-1 p-8 min-w-0">
				<WikiMainContent {...props.mainContentProps} />
			</main>
		</div>
	);
}

function deriveWikiPageState(
	pageData: ReturnType<typeof useWikiPageData>,
	pageMap: Record<string, FlatEntry>,
	editState: ReturnType<typeof useWikiEditing>,
	createForm: ReturnType<typeof useCreatePageForm>,
	toc: TocItem[]
) {
	const latestRevision = pageData.revisions[0] ?? null;
	// Breadcrumbs for current page (PROJ-114)
	const breadcrumbs = pageData.page ? getBreadcrumbs(pageData.page.id, pageMap) : [];
	// ToC sidebar (PROJ-113) — only when viewing page, ≥3 headings
	const showToc = !editState.editing && !createForm.creating && toc.length >= 3;
	const createParentTitle = createForm.createParentId
		? (pageMap[createForm.createParentId]?.title ?? null)
		: null;
	const wikiPages = Object.values(pageMap);
	const moveOptions: SelectOption[] = [
		{ value: "", label: "No parent (root)" },
		...wikiPages
			.filter((p) => p.id !== pageData.page?.id)
			.map((p) => ({ value: p.id, label: p.title })),
	];
	return { latestRevision, breadcrumbs, showToc, createParentTitle, wikiPages, moveOptions };
}

function buildCreateFormProps(create: {
	createParentTitle: string | null;
	createTitle: string;
	createSlug: string;
	createContent: string;
	createError: string | null;
	createSaving: boolean;
	onCreateTitleChange: (v: string) => void;
	onCreateSlugChange: (v: string) => void;
	setCreateContent: (v: string) => void;
	submitCreate: () => void;
	cancelCreate: () => void;
}): CreateFormProps {
	return {
		parentTitle: create.createParentTitle,
		title: create.createTitle,
		slug: create.createSlug,
		content: create.createContent,
		error: create.createError,
		saving: create.createSaving,
		onTitleChange: create.onCreateTitleChange,
		onSlugChange: create.onCreateSlugChange,
		onContentChange: create.setCreateContent,
		onSubmit: create.submitCreate,
		onCancel: create.cancelCreate,
	};
}

function buildArticleProps(article: {
	breadcrumbs: FlatEntry[];
	navigateTo: (slug: string) => void;
	showToc: boolean;
	toc: TocItem[];
	activeHeadingId: string;
	contentRef: RefObject<HTMLDivElement>;
	editing: boolean;
	editTitle: string;
	setEditTitle: (v: string) => void;
	saving: boolean;
	save: () => void;
	cancelEdit: () => void;
	startEdit: () => void;
	startCreate: (parentId: string | null) => void;
	deletePage: () => void;
	latestRevision: WikiRevision | null;
	saveError: string | null;
	draftBanner: { title: string; content: string; savedAt: number } | null;
	restoreDraft: () => void;
	discardDraft: () => void;
	editContent: string;
	setEditContent: (v: string) => void;
	wikiPages: FlatEntry[];
	revisions: WikiRevision[];
	showHistory: boolean;
	setShowHistory: (updater: (h: boolean) => boolean) => void;
	attach: ReturnType<typeof useWikiAttachments>;
	workspaceSlug: string | undefined;
	move: ReturnType<typeof useMovePage>;
	moveOptions: SelectOption[];
}): Omit<PageArticleProps, "page"> {
	return {
		breadcrumbs: article.breadcrumbs,
		onNavigate: article.navigateTo,
		showToc: article.showToc,
		toc: article.toc,
		activeHeadingId: article.activeHeadingId,
		contentRef: article.contentRef,
		editing: article.editing,
		editTitle: article.editTitle,
		onEditTitleChange: article.setEditTitle,
		saving: article.saving,
		onSave: article.save,
		onCancelEdit: article.cancelEdit,
		onStartEdit: article.startEdit,
		onStartCreateChild: article.startCreate,
		onDelete: article.deletePage,
		latestRevision: article.latestRevision,
		saveError: article.saveError,
		draftBanner: article.draftBanner,
		onRestoreDraft: article.restoreDraft,
		onDiscardDraft: article.discardDraft,
		editContent: article.editContent,
		onEditContentChange: article.setEditContent,
		wikiPages: article.wikiPages,
		revisions: article.revisions,
		showHistory: article.showHistory,
		onToggleHistory: () => article.setShowHistory((h) => !h),
		attachments: article.attach.attachments,
		workspaceSlug: article.workspaceSlug,
		uploadFormOpen: article.attach.uploadFormOpen,
		uploadFile: article.attach.uploadFile,
		uploading: article.attach.uploading,
		uploadError: article.attach.uploadError,
		onToggleUploadForm: article.attach.setUploadFormOpen,
		onFileChange: article.attach.setUploadFile,
		onUpload: article.attach.uploadAttachment,
		onCancelUpload: article.attach.cancelUpload,
		onDeleteAttachment: article.attach.deleteAttachment,
		moving: article.move.moving,
		moveOptions: article.moveOptions,
		moveTargetId: article.move.moveTargetId,
		moveSaving: article.move.moveSaving,
		moveError: article.move.moveError,
		onStartMove: article.move.startMove,
		onMoveTargetChange: article.move.setMoveTargetId,
		onSubmitMove: article.move.submitMove,
		onCancelMove: article.move.cancelMove,
	};
}

export default function WikiPage({
	workspaceSlug,
	projectId: projectIdProp,
	slug: slugProp,
}: Props) {
	const gate = useAccessGate(workspaceSlug);
	const { slug, setSlug, projectId } = useWikiUrlState(projectIdProp, slugProp);
	const { pageTree, pageMap, treeLoading, fetchTree } = useWikiTree(workspaceSlug, projectId);
	const filters = useWikiFilters(workspaceSlug, projectId);
	const { searchQuery, setSearchQuery, searchResults, searchLoading } = useWikiSearch(
		workspaceSlug,
		projectId,
		{
			filterType: filters.filterType,
			filterStatus: filters.filterStatus,
			filterTags: filters.filterTags,
		}
	);

	const pageData = useWikiPageData(workspaceSlug, slug);
	useLegacyQuerySlugRedirect(pageData.page?.slug, slug);
	useWikiPageMeta(pageData.page);
	const { toc, setToc, activeHeadingId } = useTableOfContents(pageData.page, pageData.contentRef);
	const attach = useWikiAttachments(workspaceSlug, pageData.page);
	const editState = useWikiEditing(
		workspaceSlug,
		pageData.page,
		pageData.fetchPage,
		pageData.fetchRevisions,
		pageData.revisionsLoaded ? (pageData.revisions[0]?.id ?? null) : undefined
	);
	const createForm = useCreatePageForm(workspaceSlug, projectId, fetchTree);
	const move = useMovePage(workspaceSlug, pageData.page, pageData.fetchPage, fetchTree);

	const { navigateTo, startCreate, submitCreate, deletePage } = createWikiActions({
		workspaceSlug,
		page: pageData.page,
		fetchTree,
		setSlug,
		setCreating: createForm.setCreating,
		setEditing: editState.setEditing,
		setPage: pageData.setPage,
		setError: pageData.setError,
		setToc,
		rawStartCreate: createForm.startCreate,
		rawSubmitCreate: createForm.submitCreate,
		cancelMove: move.cancelMove,
	});

	const { latestRevision, breadcrumbs, showToc, createParentTitle, wikiPages, moveOptions } =
		deriveWikiPageState(pageData, pageMap, editState, createForm, toc);

	function startEdit() {
		move.cancelMove();
		editState.startEdit();
	}

	const createProps = buildCreateFormProps({
		createParentTitle,
		createTitle: createForm.createTitle,
		createSlug: createForm.createSlug,
		createContent: createForm.createContent,
		createError: createForm.createError,
		createSaving: createForm.createSaving,
		onCreateTitleChange: createForm.onCreateTitleChange,
		onCreateSlugChange: createForm.onCreateSlugChange,
		setCreateContent: createForm.setCreateContent,
		submitCreate,
		cancelCreate: createForm.cancelCreate,
	});

	const articleProps = buildArticleProps({
		breadcrumbs,
		navigateTo,
		showToc,
		toc,
		activeHeadingId,
		contentRef: pageData.contentRef,
		editing: editState.editing,
		editTitle: editState.editTitle,
		setEditTitle: editState.setEditTitle,
		saving: editState.saving,
		save: editState.save,
		cancelEdit: editState.cancelEdit,
		startEdit,
		startCreate,
		deletePage,
		latestRevision,
		saveError: editState.saveError,
		draftBanner: editState.draftBanner,
		restoreDraft: editState.restoreDraft,
		discardDraft: editState.discardDraft,
		editContent: editState.editContent,
		setEditContent: editState.setEditContent,
		wikiPages,
		revisions: pageData.revisions,
		showHistory: pageData.showHistory,
		setShowHistory: pageData.setShowHistory,
		attach,
		workspaceSlug,
		move,
		moveOptions,
	});

	if (gate.pending) return <AccessPending />;

	return (
		<WikiPageShell
			workspaceSlug={workspaceSlug}
			projectId={projectId}
			searchQuery={searchQuery}
			onSearchQueryChange={setSearchQuery}
			searchResults={searchResults}
			searchLoading={searchLoading}
			treeLoading={treeLoading}
			pageTree={pageTree}
			slug={slug}
			onNavigate={navigateTo}
			onCreate={() => startCreate(null)}
			filters={filters}
			mainContentProps={{
				creating: createForm.creating,
				createProps,
				slug,
				loading: pageData.loading,
				error: pageData.error,
				page: pageData.page,
				articleProps,
			}}
		/>
	);
}
