import type { RefObject } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { slugify } from "../lib/slugify";
import { useAccessGate } from "../utils/access-gate";
import { apiFetch } from "../utils/api-client";
import { renderMdWithWikilinks, renderMermaidDiagrams } from "../utils/markdown";
import AccessPending from "./AccessPending";
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
						{r.excerpt && (
							<span class="block text-[0.75rem] text-text-muted truncate">{r.excerpt}</span>
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

function WikiSidebar({
	searchQuery,
	onSearchQueryChange,
	searchResults,
	searchLoading,
	treeLoading,
	pageTree,
	slug,
	onNavigate,
	onCreate,
}: {
	searchQuery: string;
	onSearchQueryChange: (value: string) => void;
	searchResults: SearchResult[];
	searchLoading: boolean;
	treeLoading: boolean;
	pageTree: TreeNode[];
	slug: string;
	onNavigate: (slug: string) => void;
	onCreate: () => void;
}) {
	const asideClass = [
		"w-[240px] shrink-0 bg-surface border-r border-border p-4 overflow-y-auto",
		"max-sm:w-full max-sm:border-r-0 max-sm:border-b",
	].join(" ");
	return (
		<aside class={asideClass}>
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
			{searchQuery.trim() ? (
				<SearchResultsList
					loading={searchLoading}
					results={searchResults}
					onSelect={(s) => {
						onSearchQueryChange("");
						onNavigate(s);
					}}
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
				onDelete={props.onDelete}
			/>

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
							__html: renderMdWithWikilinks(page.content, props.wikiPages),
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
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load page: {props.error}
			</p>
		);
	}
	if (!props.page) return null;
	return <PageArticle {...props.articleProps} page={props.page} />;
}

function useWikiUrlState(projectIdProp: string | undefined) {
	const [slug, setSlug] = useState("");
	const [projectId, setProjectId] = useState(projectIdProp ?? "");

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setSlug(params.get("slug") ?? "");
		if (!projectIdProp) setProjectId(params.get("projectId") ?? "");
	}, [projectIdProp]);

	return { slug, setSlug, projectId };
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

function useWikiSearch(workspaceSlug: string | undefined, projectId: string) {
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
	const [searchLoading, setSearchLoading] = useState(false);

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

	return { searchQuery, setSearchQuery, searchResults, searchLoading };
}

function useWikiPageData(workspaceSlug: string | undefined, slug: string) {
	const [page, setPage] = useState<WikiPageData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revisions, setRevisions] = useState<WikiRevision[]>([]);
	const [showHistory, setShowHistory] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	const fetchPage = useCallback(
		async (s: string) => {
			if (!s) return;
			setLoading(true);
			setError(null);
			setRevisions([]);
			setShowHistory(false);
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

	return {
		page,
		setPage,
		loading,
		error,
		setError,
		revisions,
		fetchRevisions,
		showHistory,
		setShowHistory,
		contentRef,
		fetchPage,
	};
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
	fetchRevisions: (s: string) => Promise<void>
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

	const skipLeaveFlushRef = useDraftAutosave(editing, editTitle, editContent, page, draftBanner);

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
	} = args;

	function navigateTo(s: string) {
		setCreating(false);
		setEditing(false);
		setPage(null);
		setError(null);
		setToc([]);
		setSlug(s);
		history.pushState(null, "", `?slug=${encodeURIComponent(s)}`);
	}

	function startCreate(parentId: string | null = null) {
		setEditing(false);
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
			history.pushState(null, "", window.location.pathname);
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
	searchQuery: string;
	onSearchQueryChange: (v: string) => void;
	searchResults: SearchResult[];
	searchLoading: boolean;
	treeLoading: boolean;
	pageTree: TreeNode[];
	slug: string;
	onNavigate: (slug: string) => void;
	onCreate: () => void;
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
				searchQuery={props.searchQuery}
				onSearchQueryChange={props.onSearchQueryChange}
				searchResults={props.searchResults}
				searchLoading={props.searchLoading}
				treeLoading={props.treeLoading}
				pageTree={props.pageTree}
				slug={props.slug}
				onNavigate={props.onNavigate}
				onCreate={props.onCreate}
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
	return { latestRevision, breadcrumbs, showToc, createParentTitle, wikiPages };
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
	};
}

export default function WikiPage({ workspaceSlug, projectId: projectIdProp }: Props) {
	const gate = useAccessGate(workspaceSlug);
	const { slug, setSlug, projectId } = useWikiUrlState(projectIdProp);
	const { pageTree, pageMap, treeLoading, fetchTree } = useWikiTree(workspaceSlug, projectId);
	const { searchQuery, setSearchQuery, searchResults, searchLoading } = useWikiSearch(
		workspaceSlug,
		projectId
	);

	const pageData = useWikiPageData(workspaceSlug, slug);
	const { toc, setToc, activeHeadingId } = useTableOfContents(pageData.page, pageData.contentRef);
	const attach = useWikiAttachments(workspaceSlug, pageData.page);
	const editState = useWikiEditing(
		workspaceSlug,
		pageData.page,
		pageData.fetchPage,
		pageData.fetchRevisions
	);
	const createForm = useCreatePageForm(workspaceSlug, projectId, fetchTree);

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
	});

	const { latestRevision, breadcrumbs, showToc, createParentTitle, wikiPages } =
		deriveWikiPageState(pageData, pageMap, editState, createForm, toc);

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
		startEdit: editState.startEdit,
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
	});

	if (gate.pending) return <AccessPending />;

	return (
		<WikiPageShell
			searchQuery={searchQuery}
			onSearchQueryChange={setSearchQuery}
			searchResults={searchResults}
			searchLoading={searchLoading}
			treeLoading={treeLoading}
			pageTree={pageTree}
			slug={slug}
			onNavigate={navigateTo}
			onCreate={() => startCreate(null)}
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
