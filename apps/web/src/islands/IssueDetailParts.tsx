import { useEffect, useRef, useState } from "preact/hooks";
import { formatIssueRef, isValidIssueRef, normalizeIssueRef } from "../lib/issue-ref";
import { parseStoryPoints } from "../lib/story-points";
import { apiFetch } from "../utils/api-client";
import { clearDraft, draftKey, loadDraft, saveDraft } from "../utils/drafts";
import { issueUrl } from "../utils/issue-url";
import { PRIORITY_OPTIONS } from "../utils/issue-utils";
import { renderMd, renderMermaidDiagrams } from "../utils/markdown";
import { categoryColor } from "./board-utils";
import type {
	Attachment,
	Comment,
	IssueData,
	IssueLink,
	Member,
	TaskStatus,
	TaskType,
} from "./issue-detail-helpers";
import {
	formatBytes,
	formatDate,
	LINK_TYPE_LABELS,
	LINK_TYPE_OPTIONS,
	PRIORITY_COLORS,
	relativeTime,
} from "./issue-detail-helpers";
import MarkdownEditor from "./LazyMarkdownEditor";
import { Button } from "./ui/Button";
import Select from "./ui/Select";

// Minimal duplicate of the mermaid rules in WikiPage.tsx's WIKI_PAGE_STYLES
// (~line 1749) — issue/comment prose uses Tailwind's typography .prose, not
// WikiPage's hand-rolled one, so there's no shared stylesheet to hang this on.
const MERMAID_PROSE_STYLES = `
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
`;

const PencilIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<title>Edit</title>
		<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
		<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
	</svg>
);

function SectionDivider({ title }: { title: string }) {
	return (
		<div class="flex items-center gap-3 mb-4">
			<span class="text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted whitespace-nowrap">
				{title}
			</span>
			<div class="flex-1 h-px bg-[var(--border)]" />
		</div>
	);
}

function SidebarField({ label, children }: { label: string; children: preact.ComponentChildren }) {
	return (
		<div class="flex items-start gap-2 py-2">
			<span class="text-[0.7rem] font-medium uppercase tracking-wider text-text-muted w-[4.5rem] shrink-0 pt-[0.2rem]">
				{label}
			</span>
			<div class="flex-1 min-w-0">{children}</div>
		</div>
	);
}

export function RefChip({ issueRef, copyUrl }: { issueRef: string; copyUrl: string }) {
	const [copiedRef, setCopiedRef] = useState(false);

	function copyLink() {
		navigator.clipboard.writeText(copyUrl).catch(() => {});
		setCopiedRef(true);
		setTimeout(() => setCopiedRef(false), 2000);
	}

	return (
		<button
			type="button"
			onClick={copyLink}
			title={copiedRef ? "Copied!" : "Copy link"}
			class="font-mono text-xs font-semibold px-2 py-[0.2rem] rounded bg-surface border
				border-border text-text-muted inline-flex items-center gap-1.5 cursor-pointer
				hover:text-text-base transition-colors"
		>
			{issueRef}
			{copiedRef ? (
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<title>Copied</title>
					<polyline points="20 6 9 17 4 12" />
				</svg>
			) : (
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<title>Copy</title>
					<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
				</svg>
			)}
		</button>
	);
}

export function ShareButton({
	issueId,
	workspaceSlug,
}: {
	issueId: string;
	workspaceSlug?: string;
}) {
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [sharingLoading, setSharingLoading] = useState(false);
	const [copiedShare, setCopiedShare] = useState(false);

	async function createShareLink() {
		if (shareUrl) {
			setShareUrl(null);
			return;
		}
		setSharingLoading(true);
		try {
			const data = await apiFetch<{ token: string; url: string }>(`/api/issues/${issueId}/share`, {
				workspaceSlug,
				method: "POST",
			});
			setShareUrl(`${window.location.origin}${data.url}`);
		} catch {
			// non-fatal
		} finally {
			setSharingLoading(false);
		}
	}

	function copyShareUrl() {
		if (!shareUrl) return;
		navigator.clipboard.writeText(shareUrl).catch(() => {});
		setCopiedShare(true);
		setTimeout(() => setCopiedShare(false), 2000);
	}

	return (
		<div class="relative">
			<Button
				onClick={createShareLink}
				disabled={sharingLoading}
				variant="outline"
				size="sm"
				title="Share issue"
			>
				{sharingLoading ? "…" : "Share"}
			</Button>
			{shareUrl && (
				<div
					class="absolute left-0 top-full mt-1 z-50 bg-[var(--bg)] border border-border rounded-md
						shadow-[var(--shadow-sm)] p-3 w-72"
				>
					<p class="text-xs text-text-muted mb-2">Share link · Expires in 3 days</p>
					<div class="flex items-center gap-1">
						<input
							type="text"
							readOnly
							value={shareUrl}
							class="flex-1 text-xs bg-surface border border-border rounded px-2 py-1 font-mono truncate"
						/>
						<Button
							onClick={copyShareUrl}
							variant="outline"
							size="sm"
							class="shrink-0"
							title={copiedShare ? "Copied!" : "Copy"}
						>
							{copiedShare ? "✓" : "Copy"}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

export function ParentBadge({ parentEpic }: { parentEpic: IssueData | null }) {
	if (!parentEpic) return null;
	const isEpic = parentEpic.type_key === "epic";
	const ref = parentEpic.project_key
		? `${parentEpic.project_key}-${parentEpic.number}`
		: `#${parentEpic.number}`;
	return (
		<a
			href={issueUrl(parentEpic.project_key, parentEpic.number, parentEpic.title, parentEpic.id)}
			class={`inline-flex items-center gap-1 px-2 py-[0.125rem] rounded no-underline text-xs font-medium border ${
				isEpic
					? "bg-[var(--epic-bg)] text-[var(--epic-text)] border-[var(--epic-border)]"
					: "bg-surface text-text-muted border-border"
			}`}
		>
			<span>{isEpic ? "⬡" : "↑"}</span>
			<span>
				{parentEpic.type_name ?? "Parent"}: {ref} {parentEpic.title}
			</span>
		</a>
	);
}

export function TitleSection({
	issue,
	issueId,
	workspaceSlug,
	fetchIssue,
}: {
	issue: IssueData;
	issueId: string;
	workspaceSlug?: string;
	fetchIssue: () => Promise<void>;
}) {
	const [editingTitle, setEditingTitle] = useState(false);
	const [editTitle, setEditTitle] = useState("");
	const [savingTitle, setSavingTitle] = useState(false);
	const [saveTitleError, setSaveTitleError] = useState<string | null>(null);

	function startEditTitle() {
		setEditTitle(issue.title);
		setSaveTitleError(null);
		setEditingTitle(true);
	}

	function cancelEditTitle() {
		setEditingTitle(false);
		setSaveTitleError(null);
	}

	async function saveTitle() {
		if (!editTitle.trim()) return;
		setSavingTitle(true);
		setSaveTitleError(null);
		try {
			await apiFetch(`/api/issues/${issueId}`, {
				workspaceSlug,
				method: "PATCH",
				body: { title: editTitle.trim() },
			});
			await fetchIssue();
			setEditingTitle(false);
		} catch (e) {
			setSaveTitleError(`Save failed: ${String(e)}`);
		} finally {
			setSavingTitle(false);
		}
	}

	if (editingTitle) {
		return (
			<div>
				{saveTitleError && (
					<p role="alert" class="text-[var(--danger-text)] mb-2 text-sm">
						{saveTitleError}
					</p>
				)}
				<input
					type="text"
					value={editTitle}
					onInput={(e) => setEditTitle((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") saveTitle();
						if (e.key === "Escape") cancelEditTitle();
					}}
					disabled={savingTitle}
					// biome-ignore lint/a11y/noAutofocus: intentional focus when the inline editor opens
					autoFocus
					class="w-full text-2xl font-bold text-text-base bg-bg border border-border rounded-md px-3
						py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
				/>
				<div class="flex gap-2">
					<Button onClick={saveTitle} disabled={savingTitle} variant="primary" size="sm">
						{savingTitle ? "Saving…" : "Save"}
					</Button>
					<Button onClick={cancelEditTitle} disabled={savingTitle} variant="outline" size="sm">
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div class="group flex items-start gap-2">
			<h1
				class="m-0 text-2xl font-bold text-text-base leading-tight cursor-pointer"
				onClick={startEditTitle}
				onKeyDown={(e) => {
					if (e.key === "Enter") startEditTitle();
				}}
				title="Click to edit title"
			>
				{issue.title}
			</h1>
			<button
				type="button"
				onClick={startEditTitle}
				title="Edit title"
				class="shrink-0 mt-[0.35rem] text-text-muted opacity-0 group-hover:opacity-100
					transition-opacity rounded p-0.5 hover:text-text-base"
			>
				<PencilIcon />
			</button>
		</div>
	);
}

function useBodyEditor(
	issue: IssueData,
	issueId: string,
	workspaceSlug: string | undefined,
	fetchIssue: () => Promise<void>
) {
	const [editingBody, setEditingBody] = useState(false);
	const [editBody, setEditBody] = useState("");
	const [savingBody, setSavingBody] = useState(false);
	const [saveBodyError, setSaveBodyError] = useState<string | null>(null);
	const key = draftKey(workspaceSlug, issueId, "body");
	const [hasDraft, setHasDraft] = useState(false);
	const bodyRef = useRef<HTMLDivElement>(null);

	// Surface an unsaved edit from a previous visit, rather than silently reopening the
	// editor — the user may have moved on, and the issue may have changed since.
	useEffect(() => {
		setHasDraft(loadDraft(key) !== null);
	}, [key]);

	// Hydrate ```mermaid code blocks into rendered diagrams (mirrors WikiPage's effect).
	// editingBody is a dep because cancelling an edit remounts the rendered container
	// with the body unchanged — hydration must run again for the fresh DOM.
	useEffect(() => {
		if (editingBody) return;
		const container = bodyRef.current;
		if (!container) return;
		renderMermaidDiagrams(container).catch(() => {
			// non-fatal — leave the raw code block visible
		});
	}, [issue.body, editingBody]);

	function startEditBody(fromDraft = false) {
		setEditBody((fromDraft ? loadDraft(key) : null) ?? issue.body ?? "");
		setSaveBodyError(null);
		setEditingBody(true);
	}

	function updateBody(value: string) {
		setEditBody(value);
		saveDraft(key, value);
		setHasDraft(!!value.trim());
	}

	function cancelEditBody() {
		setEditingBody(false);
		setSaveBodyError(null);
		clearDraft(key);
		setHasDraft(false);
	}

	async function saveBody() {
		setSavingBody(true);
		setSaveBodyError(null);
		try {
			await apiFetch(`/api/issues/${issueId}`, {
				workspaceSlug,
				method: "PATCH",
				body: { body: editBody },
			});
			// Only discard once the server has it — a failed save keeps the text.
			clearDraft(key);
			setHasDraft(false);
			await fetchIssue();
			setEditingBody(false);
		} catch (e) {
			setSaveBodyError(`Save failed: ${String(e)}`);
		} finally {
			setSavingBody(false);
		}
	}

	return {
		editingBody,
		editBody,
		savingBody,
		saveBodyError,
		hasDraft,
		bodyRef,
		startEditBody,
		updateBody,
		cancelEditBody,
		saveBody,
	};
}

function BodyEditForm({
	editBody,
	updateBody,
	saveBody,
	cancelEditBody,
	savingBody,
}: {
	editBody: string;
	updateBody: (value: string) => void;
	saveBody: () => void;
	cancelEditBody: () => void;
	savingBody: boolean;
}) {
	return (
		<div>
			<div class="mb-2">
				<MarkdownEditor value={editBody} onChange={updateBody} minHeight="240px" />
			</div>
			<div class="flex gap-2">
				<Button onClick={saveBody} disabled={savingBody} variant="primary">
					{savingBody ? "Saving…" : "Save"}
				</Button>
				<Button onClick={cancelEditBody} disabled={savingBody} variant="outline">
					Cancel
				</Button>
			</div>
		</div>
	);
}

export function BodySection({
	issue,
	issueId,
	workspaceSlug,
	fetchIssue,
}: {
	issue: IssueData;
	issueId: string;
	workspaceSlug?: string;
	fetchIssue: () => Promise<void>;
}) {
	const {
		editingBody,
		editBody,
		savingBody,
		saveBodyError,
		hasDraft,
		bodyRef,
		startEditBody,
		updateBody,
		cancelEditBody,
		saveBody,
	} = useBodyEditor(issue, issueId, workspaceSlug, fetchIssue);

	return (
		<section class="mb-8">
			<div class="flex items-center gap-3 mb-4">
				<span class="text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted whitespace-nowrap">
					Description
				</span>
				<div class="flex-1 h-px bg-[var(--border)]" />
				{!editingBody && (
					<button
						type="button"
						onClick={() => startEditBody()}
						title="Edit description"
						class="text-text-muted hover:text-text-base transition-colors rounded p-0.5"
					>
						<PencilIcon />
					</button>
				)}
			</div>

			{saveBodyError && (
				<p role="alert" class="text-[var(--danger-text)] mb-2 text-sm">
					{saveBodyError}
				</p>
			)}

			{!editingBody && hasDraft && (
				<p class="mb-3 text-sm text-text-muted">
					You have an unsaved description edit.{" "}
					<button
						type="button"
						onClick={() => startEditBody(true)}
						class="underline bg-transparent border-0 p-0 text-inherit cursor-pointer font-[inherit]"
					>
						Resume editing
					</button>
				</p>
			)}

			{editingBody ? (
				<BodyEditForm
					editBody={editBody}
					updateBody={updateBody}
					saveBody={saveBody}
					cancelEditBody={cancelEditBody}
					savingBody={savingBody}
				/>
			) : issue.body ? (
				<div
					ref={bodyRef}
					class="prose prose-sm max-w-none overflow-x-auto break-words"
					dangerouslySetInnerHTML={{ __html: renderMd(issue.body) }}
				/>
			) : (
				<p class="text-text-muted italic">No description.</p>
			)}
			<style>{MERMAID_PROSE_STYLES}</style>
		</section>
	);
}

export function ChildIssuesSection({
	issue,
	childIssues,
}: {
	issue: IssueData;
	childIssues: IssueData[];
}) {
	if (issue.type_key !== "epic") return null;

	return (
		<section class="mb-8">
			<div class="flex items-center gap-3 mb-4">
				<span class="text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted whitespace-nowrap">
					Child issues{childIssues.length > 0 && ` (${childIssues.length})`}
				</span>
				{issue.rollup && issue.rollup.total > 0 && (
					<span class="text-xs text-text-muted whitespace-nowrap">
						{issue.rollup.done} done · {issue.rollup.remaining} remaining
					</span>
				)}
				<div class="flex-1 h-px bg-[var(--border)]" />
			</div>
			{childIssues.length === 0 ? (
				<p class="text-text-muted italic">No child issues yet.</p>
			) : (
				<div class="flex flex-col gap-2">
					{childIssues.map((child) => {
						const childRef = child.project_key
							? `${child.project_key}-${child.number}`
							: `#${child.number}`;
						return (
							<div
								key={child.id}
								class="flex items-center gap-[0.625rem] px-3 py-2 border border-border rounded-md bg-surface flex-wrap"
							>
								<span class="font-mono text-[0.8rem] text-text-muted shrink-0">{childRef}</span>
								<a
									href={issueUrl(child.project_key, child.number, child.title, child.id)}
									class="text-text-base no-underline text-sm flex-1 min-w-0 truncate hover:underline"
								>
									{child.title}
								</a>
								{child.status_category && (
									<span
										class="px-2 py-[0.125rem] rounded text-xs font-medium border border-border shrink-0"
										style={{ color: categoryColor(child.status_category) }}
									>
										{child.status_name ?? child.status_category.replace("_", " ")}
									</span>
								)}
								{child.priority && child.priority !== "none" && (
									<span
										class="px-2 py-[0.125rem] rounded text-xs font-medium shrink-0 capitalize"
										style={{
											background: `var(--priority-${child.priority}-bg)`,
											color: `var(--priority-${child.priority}-text)`,
										}}
									>
										{child.priority}
									</span>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

function LinkItem({ link, onRemove }: { link: IssueLink; onRemove: () => void }) {
	const ref = formatIssueRef(link.linkedIssueProjectKey, link.linkedIssueNumber);
	return (
		<span
			class="inline-flex items-center gap-[0.375rem] px-2 py-1 border border-border
				rounded-md bg-surface text-[0.8rem]"
		>
			<a
				href={issueUrl(
					link.linkedIssueProjectKey,
					link.linkedIssueNumber,
					link.linkedIssueTitle,
					link.linkedIssueId
				)}
				class="text-accent no-underline inline-flex items-center gap-[0.375rem]"
			>
				<span class="font-mono text-text-muted">{ref}</span>
				<span class="text-text-base">{link.linkedIssueTitle}</span>
				{link.linkedIssueStatusCategory && (
					<span
						class="px-[0.375rem] py-[0.0625rem] rounded-[3px] text-[0.7rem] bg-[var(--priority-low-bg)] font-medium"
						style={{ color: categoryColor(link.linkedIssueStatusCategory) }}
					>
						{link.linkedIssueStatusCategory.replace("_", " ")}
					</span>
				)}
			</a>
			<Button
				onClick={onRemove}
				aria-label={`Remove ${ref} link`}
				size="sm"
				class="bg-transparent border-none text-text-muted px-[0.125rem] leading-none"
			>
				×
			</Button>
		</span>
	);
}

function LinkForm({
	linkFormType,
	setLinkFormType,
	linkFormRef,
	setLinkFormRef,
	linkFormError,
	setLinkFormError,
	addingLink,
	onAdd,
	onCancel,
}: {
	linkFormType: string;
	setLinkFormType: (v: string) => void;
	linkFormRef: string;
	setLinkFormRef: (v: string) => void;
	linkFormError: string | null;
	setLinkFormError: (v: string | null) => void;
	addingLink: boolean;
	onAdd: () => void;
	onCancel: () => void;
}) {
	return (
		<div class="flex flex-wrap gap-2 items-start max-sm:flex-col">
			<Select
				ariaLabel="Link type"
				value={linkFormType}
				onChange={setLinkFormType}
				options={LINK_TYPE_OPTIONS}
			/>
			<input
				type="text"
				value={linkFormRef}
				onInput={(e) => {
					setLinkFormRef((e.target as HTMLInputElement).value);
					setLinkFormError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") onAdd();
					if (e.key === "Escape") onCancel();
				}}
				placeholder="PROJ-12"
				// biome-ignore lint/a11y/noAutofocus: intentional focus when the inline editor opens
				autoFocus
				class="px-[0.625rem] py-[0.375rem] border border-border rounded text-sm w-28 max-sm:w-full bg-bg text-text-base"
			/>
			<Button onClick={onAdd} disabled={addingLink} variant="primary">
				{addingLink ? "Adding…" : "Add"}
			</Button>
			<Button onClick={onCancel} variant="outline">
				Cancel
			</Button>
			{linkFormError && (
				<span role="alert" class="text-[0.8rem] text-[var(--danger-text)] self-center">
					{linkFormError}
				</span>
			)}
		</div>
	);
}

export function RelationsSection({
	issueId,
	workspaceSlug,
	links,
	fetchingLinks,
	fetchLinks,
}: {
	issueId: string;
	workspaceSlug?: string;
	links: IssueLink[];
	fetchingLinks: boolean;
	fetchLinks: () => Promise<void>;
}) {
	const [linkFormOpen, setLinkFormOpen] = useState(false);
	const [linkFormType, setLinkFormType] = useState<string>("relates_to");
	const [linkFormRef, setLinkFormRef] = useState("");
	const [addingLink, setAddingLink] = useState(false);
	const [linkFormError, setLinkFormError] = useState<string | null>(null);

	const linksByType = (["blocked_by", "blocks", "relates_to", "duplicates"] as const)
		.map((type) => ({
			type,
			label: LINK_TYPE_LABELS[type],
			items: links.filter((l) => l.type === type),
		}))
		.filter((g) => g.items.length > 0);

	async function addLink() {
		const ref = normalizeIssueRef(linkFormRef);
		if (!ref) {
			setLinkFormError("Enter an issue reference (e.g. PROJ-12)");
			return;
		}
		if (!isValidIssueRef(ref)) {
			setLinkFormError("Format must be KEY-NUMBER (e.g. PROJ-12)");
			return;
		}

		setAddingLink(true);
		setLinkFormError(null);
		try {
			let resolved: { id: string };
			try {
				resolved = await apiFetch<{ id: string }>(`/api/issues/${ref}`, { workspaceSlug });
			} catch {
				setLinkFormError(`Issue ${ref} not found`);
				return;
			}

			await apiFetch(`/api/issues/${issueId}/links`, {
				workspaceSlug,
				method: "POST",
				body: { targetIssueId: resolved.id, type: linkFormType },
			});
			setLinkFormRef("");
			setLinkFormOpen(false);
			await fetchLinks();
		} catch (e) {
			setLinkFormError(String(e));
		} finally {
			setAddingLink(false);
		}
	}

	async function removeLink(linkId: string) {
		try {
			await apiFetch(`/api/issues/${issueId}/links/${linkId}`, { workspaceSlug, method: "DELETE" });
			await fetchLinks();
		} catch {
			// non-fatal
		}
	}

	return (
		<section class="mb-8">
			<SectionDivider title={`Relations${links.length > 0 ? ` (${links.length})` : ""}`} />

			{fetchingLinks && links.length === 0 && <p class="text-text-muted text-sm">Loading…</p>}

			{linksByType.length > 0 && (
				<div class="mb-4">
					{linksByType.map((group) => (
						<div key={group.type} class="mb-3">
							<p class="m-0 mb-[0.375rem] text-xs font-semibold text-text-muted uppercase tracking-[0.04em]">
								{group.label}
							</p>
							<div class="flex flex-wrap gap-2">
								{group.items.map((link) => (
									<LinkItem key={link.id} link={link} onRemove={() => removeLink(link.id)} />
								))}
							</div>
						</div>
					))}
				</div>
			)}

			{linkFormOpen ? (
				<LinkForm
					linkFormType={linkFormType}
					setLinkFormType={setLinkFormType}
					linkFormRef={linkFormRef}
					setLinkFormRef={setLinkFormRef}
					linkFormError={linkFormError}
					setLinkFormError={setLinkFormError}
					addingLink={addingLink}
					onAdd={addLink}
					onCancel={() => setLinkFormOpen(false)}
				/>
			) : (
				<button
					type="button"
					onClick={() => setLinkFormOpen(true)}
					class="text-sm text-text-muted hover:text-text-base transition-colors flex items-center gap-1"
				>
					<span class="text-base leading-none">+</span>
					<span>Add relation</span>
				</button>
			)}
		</section>
	);
}

const FileIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0"
	>
		<title>File</title>
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<path d="M14 2v6h6" />
	</svg>
);

const WikiIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0"
	>
		<title>Wiki page</title>
		<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
		<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
	</svg>
);

const LinkIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0"
	>
		<title>External link</title>
		<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
		<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
	</svg>
);

function resolveAttachmentDisplay(
	attachment: Attachment,
	qs: string
): {
	icon: preact.ComponentChildren;
	href: string | null;
	label: string;
	meta: string | null;
	external: boolean;
} {
	if (attachment.kind === "wiki_ref" && attachment.wikiPage) {
		return {
			icon: <WikiIcon />,
			href: attachment.wikiPage.url,
			label: attachment.wikiPage.title,
			meta: null,
			external: false,
		};
	}
	if (attachment.kind === "url" && attachment.url) {
		return {
			icon: <LinkIcon />,
			href: attachment.url,
			label: attachment.filename || attachment.url,
			meta: null,
			external: true,
		};
	}
	if (attachment.kind === "file") {
		return {
			icon: <FileIcon />,
			href: `/api/files/${attachment.id}${qs}`,
			label: attachment.filename,
			meta: formatBytes(attachment.size),
			external: true,
		};
	}
	// A wiki_ref whose target page was deleted, or is no longer visible to this
	// user (project access revoked) — the join comes back empty either way.
	return {
		icon: <WikiIcon />,
		href: null,
		label: "Wiki page unavailable",
		meta: null,
		external: false,
	};
}

function AttachmentRow({
	attachment,
	workspaceSlug,
	onDelete,
}: {
	attachment: Attachment;
	workspaceSlug?: string;
	onDelete: () => void;
}) {
	const qs = workspaceSlug ? `?workspace=${workspaceSlug}` : "";
	const { icon, href, label, meta, external } = resolveAttachmentDisplay(attachment, qs);

	return (
		<div class="flex items-center gap-3 px-3 py-2 border border-border rounded-md bg-surface min-h-[44px]">
			<span class="text-text-muted">{icon}</span>
			{href ? (
				<a
					href={href}
					{...(external ? { target: "_blank", rel: "noreferrer" } : {})}
					class="text-accent text-sm no-underline hover:underline flex-1 min-w-0 truncate"
				>
					{label}
				</a>
			) : (
				<span class="text-text-muted text-sm italic flex-1 min-w-0 truncate">{label}</span>
			)}
			{meta && <span class="text-xs text-text-muted shrink-0">{meta}</span>}
			<Button
				onClick={onDelete}
				aria-label={`Remove ${label}`}
				size="sm"
				class="bg-transparent border-none text-text-muted px-[0.125rem] leading-none min-h-[44px] min-w-[44px]"
			>
				×
			</Button>
		</div>
	);
}

function AttachmentUploadForm({
	uploadFile,
	setUploadFile,
	uploadError,
	setUploadError,
	uploading,
	onUpload,
	onCancel,
}: {
	uploadFile: File | null;
	setUploadFile: (f: File | null) => void;
	uploadError: string | null;
	setUploadError: (e: string | null) => void;
	uploading: boolean;
	onUpload: () => void;
	onCancel: () => void;
}) {
	return (
		<div class="flex flex-wrap gap-2 items-center max-sm:flex-col max-sm:items-stretch">
			<label class="relative cursor-pointer max-sm:w-full">
				<input
					type="file"
					class="sr-only"
					onChange={(e) => {
						const f = (e.target as HTMLInputElement).files?.[0] ?? null;
						setUploadFile(f);
						setUploadError(null);
					}}
				/>
				<Button
					as="span"
					variant="outline"
					size="sm"
					class="max-sm:w-full max-sm:min-h-[44px] truncate block text-center"
				>
					{uploadFile ? uploadFile.name : "Choose file"}
				</Button>
			</label>
			<div class="flex gap-2 max-sm:w-full">
				<Button
					onClick={onUpload}
					disabled={!uploadFile || uploading}
					variant="primary"
					class="max-sm:flex-1 max-sm:min-h-[44px]"
				>
					{uploading ? "Uploading…" : "Upload"}
				</Button>
				<Button onClick={onCancel} variant="outline" class="max-sm:flex-1 max-sm:min-h-[44px]">
					Cancel
				</Button>
			</div>
			{uploadError && (
				<span role="alert" class="text-[0.8rem] text-[var(--danger-text)] self-center">
					{uploadError}
				</span>
			)}
		</div>
	);
}

interface WikiSearchResult {
	id: string;
	slug: string;
	title: string;
	project_id: string | null;
}

function WikiPageLinkForm({
	workspaceSlug,
	linking,
	linkError,
	setLinkError,
	onLink,
	onCancel,
}: {
	workspaceSlug?: string;
	linking: boolean;
	linkError: string | null;
	setLinkError: (e: string | null) => void;
	onLink: (wikiPageId: string) => void;
	onCancel: () => void;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<WikiSearchResult[]>([]);
	const [searching, setSearching] = useState(false);

	useEffect(() => {
		if (!query.trim()) {
			setResults([]);
			return;
		}
		let cancelled = false;
		setSearching(true);
		const timer = setTimeout(async () => {
			try {
				const qs = new URLSearchParams({ q: query.trim() });
				const data = await apiFetch<WikiSearchResult[]>(`/api/wiki/search?${qs}`, {
					workspaceSlug,
				});
				if (!cancelled) setResults(Array.isArray(data) ? data : []);
			} catch {
				if (!cancelled) setResults([]);
			} finally {
				if (!cancelled) setSearching(false);
			}
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, workspaceSlug]);

	return (
		<div class="flex flex-col gap-2 max-w-sm max-sm:max-w-none">
			<input
				type="text"
				value={query}
				onInput={(e) => {
					setQuery((e.target as HTMLInputElement).value);
					setLinkError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") onCancel();
				}}
				placeholder="Search wiki pages…"
				// biome-ignore lint/a11y/noAutofocus: intentional focus when the inline picker opens
				autoFocus
				disabled={linking}
				class="px-[0.625rem] py-[0.5rem] border border-border rounded text-sm bg-bg text-text-base min-h-[44px]"
			/>
			{searching && <p class="text-xs text-text-muted m-0">Searching…</p>}
			{results.length > 0 && (
				<ul class="list-none m-0 p-0 flex flex-col gap-1 max-h-56 overflow-y-auto">
					{results.map((r) => (
						<li key={r.id}>
							<button
								type="button"
								disabled={linking}
								onClick={() => onLink(r.id)}
								class="w-full text-left px-[0.625rem] py-2 border border-border rounded text-sm
									bg-surface hover:bg-bg transition-colors min-h-[44px]"
							>
								{r.title}
							</button>
						</li>
					))}
				</ul>
			)}
			<div class="flex gap-2">
				<Button
					onClick={onCancel}
					disabled={linking}
					variant="outline"
					size="sm"
					class="max-sm:flex-1 max-sm:min-h-[44px]"
				>
					Cancel
				</Button>
			</div>
			{linkError && (
				<span role="alert" class="text-[0.8rem] text-[var(--danger-text)]">
					{linkError}
				</span>
			)}
		</div>
	);
}

function UrlLinkForm({
	urlValue,
	setUrlValue,
	labelValue,
	setLabelValue,
	linkError,
	setLinkError,
	linking,
	onAdd,
	onCancel,
}: {
	urlValue: string;
	setUrlValue: (v: string) => void;
	labelValue: string;
	setLabelValue: (v: string) => void;
	linkError: string | null;
	setLinkError: (e: string | null) => void;
	linking: boolean;
	onAdd: () => void;
	onCancel: () => void;
}) {
	return (
		<div class="flex flex-wrap gap-2 items-start max-sm:flex-col">
			<input
				type="url"
				value={urlValue}
				onInput={(e) => {
					setUrlValue((e.target as HTMLInputElement).value);
					setLinkError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") onAdd();
					if (e.key === "Escape") onCancel();
				}}
				placeholder="https://example.com/…"
				// biome-ignore lint/a11y/noAutofocus: intentional focus when the inline editor opens
				autoFocus
				disabled={linking}
				class="px-[0.625rem] py-[0.375rem] border border-border rounded text-sm flex-1 min-w-[10rem]
					max-sm:w-full bg-bg text-text-base min-h-[44px]"
			/>
			<input
				type="text"
				value={labelValue}
				onInput={(e) => setLabelValue((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") onAdd();
					if (e.key === "Escape") onCancel();
				}}
				placeholder="Label (optional)"
				disabled={linking}
				class="px-[0.625rem] py-[0.375rem] border border-border rounded text-sm w-40
					max-sm:w-full bg-bg text-text-base min-h-[44px]"
			/>
			<div class="flex gap-2 max-sm:w-full">
				<Button
					onClick={onAdd}
					disabled={linking || !urlValue.trim()}
					variant="primary"
					class="max-sm:flex-1 max-sm:min-h-[44px]"
				>
					{linking ? "Adding…" : "Add"}
				</Button>
				<Button
					onClick={onCancel}
					disabled={linking}
					variant="outline"
					class="max-sm:flex-1 max-sm:min-h-[44px]"
				>
					Cancel
				</Button>
			</div>
			{linkError && (
				<span role="alert" class="text-[0.8rem] text-[var(--danger-text)] self-center">
					{linkError}
				</span>
			)}
		</div>
	);
}

type AttachMode = "none" | "file" | "wiki" | "url";

function useAttachmentUpload(
	issueId: string,
	workspaceSlug: string | undefined,
	onDone: () => void,
	fetchAttachments: () => Promise<void>
) {
	const [uploadFile, setUploadFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);

	function reset() {
		setUploadFile(null);
		setUploadError(null);
	}

	async function uploadAttachment() {
		if (!uploadFile) return;
		setUploading(true);
		setUploadError(null);
		try {
			const form = new FormData();
			form.append("file", uploadFile);
			form.append("entityType", "issue");
			form.append("entityId", issueId);
			await apiFetch("/api/files", { workspaceSlug, method: "POST", body: form });
			onDone();
			await fetchAttachments();
		} catch (e) {
			setUploadError(String(e));
		} finally {
			setUploading(false);
		}
	}

	return {
		uploadFile,
		setUploadFile,
		uploading,
		uploadError,
		setUploadError,
		uploadAttachment,
		reset,
	};
}

function useAttachmentLinks(
	issueId: string,
	workspaceSlug: string | undefined,
	onDone: () => void,
	fetchAttachments: () => Promise<void>
) {
	const [linking, setLinking] = useState(false);
	const [linkError, setLinkError] = useState<string | null>(null);
	const [urlValue, setUrlValue] = useState("");
	const [labelValue, setLabelValue] = useState("");

	function reset() {
		setLinkError(null);
		setUrlValue("");
		setLabelValue("");
	}

	async function linkWikiPage(wikiPageId: string) {
		setLinking(true);
		setLinkError(null);
		try {
			await apiFetch("/api/files/links", {
				workspaceSlug,
				method: "POST",
				body: { kind: "wiki_ref", entityType: "issue", entityId: issueId, wikiPageId },
			});
			onDone();
			await fetchAttachments();
		} catch (e) {
			setLinkError(String(e));
		} finally {
			setLinking(false);
		}
	}

	async function addUrl() {
		if (!urlValue.trim()) return;
		setLinking(true);
		setLinkError(null);
		try {
			await apiFetch("/api/files/links", {
				workspaceSlug,
				method: "POST",
				body: {
					kind: "url",
					entityType: "issue",
					entityId: issueId,
					url: urlValue.trim(),
					label: labelValue.trim() || undefined,
				},
			});
			onDone();
			await fetchAttachments();
		} catch (e) {
			setLinkError(String(e));
		} finally {
			setLinking(false);
		}
	}

	return {
		linking,
		linkError,
		setLinkError,
		urlValue,
		setUrlValue,
		labelValue,
		setLabelValue,
		linkWikiPage,
		addUrl,
		reset,
	};
}

function useAttachmentForms(
	issueId: string,
	workspaceSlug: string | undefined,
	fetchAttachments: () => Promise<void>
) {
	const [mode, setMode] = useState<AttachMode>("none");

	function resetForms() {
		setMode("none");
		upload.reset();
		links.reset();
	}

	const upload = useAttachmentUpload(issueId, workspaceSlug, resetForms, fetchAttachments);
	const links = useAttachmentLinks(issueId, workspaceSlug, resetForms, fetchAttachments);

	async function deleteAttachment(attachmentId: string) {
		try {
			await apiFetch(`/api/files/${attachmentId}`, { workspaceSlug, method: "DELETE" });
			await fetchAttachments();
		} catch {
			// non-fatal
		}
	}

	return { mode, setMode, upload, links, resetForms, deleteAttachment };
}

export function AttachmentsSection({
	issueId,
	workspaceSlug,
	attachments,
	fetchAttachments,
}: {
	issueId: string;
	workspaceSlug?: string;
	attachments: Attachment[];
	fetchAttachments: () => Promise<void>;
}) {
	const { mode, setMode, upload, links, resetForms, deleteAttachment } = useAttachmentForms(
		issueId,
		workspaceSlug,
		fetchAttachments
	);

	return (
		<section class="mb-8">
			<SectionDivider
				title={`Attachments${attachments.length > 0 ? ` (${attachments.length})` : ""}`}
			/>

			{attachments.length > 0 && (
				<div class="mb-4 flex flex-col gap-2">
					{attachments.map((a) => (
						<AttachmentRow
							key={a.id}
							attachment={a}
							workspaceSlug={workspaceSlug}
							onDelete={() => deleteAttachment(a.id)}
						/>
					))}
				</div>
			)}

			{mode === "file" && (
				<AttachmentUploadForm
					uploadFile={upload.uploadFile}
					setUploadFile={upload.setUploadFile}
					uploadError={upload.uploadError}
					setUploadError={upload.setUploadError}
					uploading={upload.uploading}
					onUpload={upload.uploadAttachment}
					onCancel={resetForms}
				/>
			)}
			{mode === "wiki" && (
				<WikiPageLinkForm
					workspaceSlug={workspaceSlug}
					linking={links.linking}
					linkError={links.linkError}
					setLinkError={links.setLinkError}
					onLink={links.linkWikiPage}
					onCancel={resetForms}
				/>
			)}
			{mode === "url" && (
				<UrlLinkForm
					urlValue={links.urlValue}
					setUrlValue={links.setUrlValue}
					labelValue={links.labelValue}
					setLabelValue={links.setLabelValue}
					linkError={links.linkError}
					setLinkError={links.setLinkError}
					linking={links.linking}
					onAdd={links.addUrl}
					onCancel={resetForms}
				/>
			)}

			{mode === "none" && (
				<div class="flex flex-wrap gap-x-4 gap-y-2 max-sm:flex-col max-sm:gap-2">
					<button
						type="button"
						onClick={() => setMode("file")}
						class="text-sm text-text-muted hover:text-text-base transition-colors flex items-center gap-1 max-sm:min-h-[44px]"
					>
						<span class="text-base leading-none">+</span>
						<span>Attach file</span>
					</button>
					<button
						type="button"
						onClick={() => setMode("wiki")}
						class="text-sm text-text-muted hover:text-text-base transition-colors flex items-center gap-1 max-sm:min-h-[44px]"
					>
						<span class="text-base leading-none">+</span>
						<span>Link wiki page</span>
					</button>
					<button
						type="button"
						onClick={() => setMode("url")}
						class="text-sm text-text-muted hover:text-text-base transition-colors flex items-center gap-1 max-sm:min-h-[44px]"
					>
						<span class="text-base leading-none">+</span>
						<span>Add URL</span>
					</button>
				</div>
			)}
		</section>
	);
}

function CommentItem({
	comment,
	isEditing,
	editBody,
	editError,
	saving,
	canModify,
	onStartEdit,
	onCancelEdit,
	onChangeBody,
	onSave,
	onDelete,
}: {
	comment: Comment;
	isEditing: boolean;
	editBody: string;
	editError: string | null;
	saving: boolean;
	canModify: boolean;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onChangeBody: (v: string) => void;
	onSave: () => void;
	onDelete: () => void;
}) {
	const bodyRef = useRef<HTMLDivElement>(null);

	// Hydrate ```mermaid code blocks into rendered diagrams (mirrors WikiPage's effect).
	// isEditing is a dep because cancelling an edit remounts the rendered container
	// with the body unchanged — hydration must run again for the fresh DOM.
	useEffect(() => {
		if (isEditing) return;
		const container = bodyRef.current;
		if (!container) return;
		renderMermaidDiagrams(container).catch(() => {
			// non-fatal — leave the raw code block visible
		});
	}, [comment.body, isEditing]);

	return (
		<div class="px-4 py-3 border border-border rounded-lg mb-3 bg-surface shadow-[var(--shadow-sm)]">
			<div class="flex justify-between mb-[0.375rem]">
				<span class="font-semibold text-sm text-text-base">
					{comment.author_name || comment.author_email}
				</span>
				<div class="flex items-center gap-2">
					<span class="text-xs text-text-muted" title={formatDate(comment.created_at)}>
						{relativeTime(comment.created_at)}
					</span>
					{canModify && !isEditing && (
						<>
							<Button onClick={onStartEdit} variant="outline" size="sm">
								Edit
							</Button>
							<Button
								onClick={onDelete}
								size="sm"
								class="bg-transparent border border-[var(--danger-text)] text-[var(--danger-text)]"
							>
								Delete
							</Button>
						</>
					)}
				</div>
			</div>
			{isEditing ? (
				<div>
					{editError && (
						<p role="alert" class="text-[var(--danger-text)] mb-2 text-sm">
							{editError}
						</p>
					)}
					<textarea
						value={editBody}
						onInput={(e) => onChangeBody((e.target as HTMLTextAreaElement).value)}
						rows={4}
						class="w-full px-3 py-2 border border-border rounded text-sm resize-y box-border mb-2 bg-bg text-text-base"
					/>
					<div class="flex gap-2">
						<Button onClick={onSave} disabled={saving} variant="primary">
							{saving ? "Saving…" : "Save"}
						</Button>
						<Button onClick={onCancelEdit} disabled={saving} variant="outline">
							Cancel
						</Button>
					</div>
				</div>
			) : (
				<div
					ref={bodyRef}
					class="prose prose-sm max-w-none overflow-x-auto break-words"
					dangerouslySetInnerHTML={{ __html: renderMd(comment.body) }}
				/>
			)}
		</div>
	);
}

function useCommentEditing(
	issueId: string,
	workspaceSlug: string | undefined,
	fetchComments: () => Promise<void>
) {
	const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
	const [editCommentBody, setEditCommentBody] = useState("");
	const [savingComment, setSavingComment] = useState(false);
	const [editCommentError, setEditCommentError] = useState<string | null>(null);

	function startEditComment(comment: Comment) {
		setEditingCommentId(comment.id);
		setEditCommentBody(comment.body);
		setEditCommentError(null);
	}

	function cancelEditComment() {
		setEditingCommentId(null);
		setEditCommentError(null);
	}

	async function saveEditComment(commentId: string) {
		setSavingComment(true);
		setEditCommentError(null);
		try {
			await apiFetch(`/api/issues/${issueId}/comments/${commentId}`, {
				workspaceSlug,
				method: "PATCH",
				body: { body: editCommentBody },
			});
			setEditingCommentId(null);
			await fetchComments();
		} catch (e) {
			setEditCommentError(`Save failed: ${String(e)}`);
		} finally {
			setSavingComment(false);
		}
	}

	async function doDeleteComment(commentId: string) {
		if (!window.confirm("Delete this comment?")) return;
		try {
			await apiFetch(`/api/issues/${issueId}/comments/${commentId}`, {
				workspaceSlug,
				method: "DELETE",
			});
			await fetchComments();
		} catch {
			// non-fatal
		}
	}

	return {
		editingCommentId,
		editCommentBody,
		setEditCommentBody,
		savingComment,
		editCommentError,
		startEditComment,
		cancelEditComment,
		saveEditComment,
		doDeleteComment,
	};
}

function useNewCommentForm(
	issueId: string,
	workspaceSlug: string | undefined,
	fetchComments: () => Promise<void>
) {
	const [newComment, setNewComment] = useState("");
	const [postingComment, setPostingComment] = useState(false);
	const [commentError, setCommentError] = useState<string | null>(null);
	const key = draftKey(workspaceSlug, issueId, "comment");

	// Restore any unsent comment. Keyed on issueId so switching issues picks up that
	// issue's own draft rather than carrying text across.
	useEffect(() => {
		setNewComment(loadDraft(key) ?? "");
	}, [key]);

	function updateComment(value: string) {
		setNewComment(value);
		saveDraft(key, value);
	}

	async function submitComment(e: Event) {
		e.preventDefault();
		if (!newComment.trim()) return;
		setPostingComment(true);
		setCommentError(null);
		try {
			await apiFetch(`/api/issues/${issueId}/comments`, {
				workspaceSlug,
				method: "POST",
				body: { body: newComment.trim() },
			});
			// Only discard the draft once the server has it — a failed post keeps the text.
			clearDraft(key);
			setNewComment("");
			await fetchComments();
		} catch (e) {
			setCommentError(`Failed to post comment: ${String(e)}`);
		} finally {
			setPostingComment(false);
		}
	}

	return { newComment, setNewComment: updateComment, postingComment, commentError, submitComment };
}

export function CommentsSection({
	issueId,
	workspaceSlug,
	comments,
	currentUserId,
	fetchComments,
}: {
	issueId: string;
	workspaceSlug?: string;
	comments: Comment[];
	currentUserId: string | null;
	fetchComments: () => Promise<void>;
}) {
	const {
		editingCommentId,
		editCommentBody,
		setEditCommentBody,
		savingComment,
		editCommentError,
		startEditComment,
		cancelEditComment,
		saveEditComment,
		doDeleteComment,
	} = useCommentEditing(issueId, workspaceSlug, fetchComments);

	const { newComment, setNewComment, postingComment, commentError, submitComment } =
		useNewCommentForm(issueId, workspaceSlug, fetchComments);

	return (
		<section>
			<SectionDivider title={`Comments${comments.length > 0 ? ` (${comments.length})` : ""}`} />

			{comments.length === 0 ? (
				<p class="text-text-muted mb-4">No comments yet.</p>
			) : (
				<div class="mb-6">
					{comments.map((c) => (
						<CommentItem
							key={c.id}
							comment={c}
							isEditing={editingCommentId === c.id}
							editBody={editCommentBody}
							editError={editCommentError}
							saving={savingComment}
							canModify={!!currentUserId && c.author_id === currentUserId}
							onStartEdit={() => startEditComment(c)}
							onCancelEdit={cancelEditComment}
							onChangeBody={setEditCommentBody}
							onSave={() => saveEditComment(c.id)}
							onDelete={() => doDeleteComment(c.id)}
						/>
					))}
				</div>
			)}

			<form onSubmit={submitComment}>
				{commentError && (
					<p role="alert" class="text-[var(--danger-text)] mb-2 text-sm">
						{commentError}
					</p>
				)}
				<textarea
					value={newComment}
					onInput={(e) => setNewComment((e.target as HTMLTextAreaElement).value)}
					placeholder="Add a comment…"
					rows={4}
					// text-base (16px) on phones: below 16px iOS Safari zooms the viewport
					// when the field takes focus. sm:text-sm keeps desktop as it was.
					class={
						"w-full px-3 py-2 border border-border rounded text-base sm:text-sm " +
						"resize-y box-border mb-2 bg-bg text-text-base"
					}
				/>
				<Button
					type="submit"
					disabled={postingComment || !newComment.trim()}
					variant="primary"
					class="max-sm:w-full min-h-[44px]"
				>
					{postingComment ? "Posting…" : "Comment"}
				</Button>
			</form>
		</section>
	);
}

function StatusField({
	issue,
	statuses,
	updatingStatus,
	changeStatus,
}: {
	issue: IssueData;
	statuses: TaskStatus[];
	updatingStatus: boolean;
	changeStatus: (statusId: string) => void;
}) {
	if (statuses.length > 0) {
		return (
			<Select
				ariaLabel="Change status"
				value={issue.status_id ?? ""}
				disabled={updatingStatus}
				onChange={(v) => changeStatus(v)}
				options={statuses.map((s) => ({ value: s.id, label: s.name }))}
				buttonStyle={{ color: categoryColor(issue.status_category), fontWeight: 500 }}
			/>
		);
	}
	if (issue.status_name) {
		return (
			<span class="text-sm font-medium" style={{ color: categoryColor(issue.status_category) }}>
				{issue.status_name}
			</span>
		);
	}
	return <span class="text-sm text-text-muted">—</span>;
}

function TypeField({
	issue,
	taskTypes,
	updatingType,
	changeType,
}: {
	issue: IssueData;
	taskTypes: TaskType[];
	updatingType: boolean;
	changeType: (typeId: string) => void;
}) {
	if (taskTypes.length > 0) {
		return (
			<Select
				ariaLabel="Change type"
				value={issue.type_id ?? ""}
				disabled={updatingType}
				onChange={(v) => changeType(v)}
				options={[
					{ value: "", label: "No type" },
					...taskTypes.map((t) => ({ value: t.id, label: t.name })),
				]}
			/>
		);
	}
	if (issue.type_name) {
		return <span class="text-sm text-text-base">{issue.type_name}</span>;
	}
	return <span class="text-sm text-text-muted">—</span>;
}

function PointsField({
	issueId,
	workspaceSlug,
	storyPointsValue,
	fetchIssue,
}: {
	issueId: string;
	workspaceSlug?: string;
	storyPointsValue: string;
	fetchIssue: () => Promise<void>;
}) {
	const [editingPoints, setEditingPoints] = useState(false);
	const [pointsValue, setPointsValue] = useState("");
	const [savingPoints, setSavingPoints] = useState(false);

	function startEditPoints() {
		setPointsValue(storyPointsValue);
		setEditingPoints(true);
	}

	async function savePoints() {
		const parsed = parseStoryPoints(pointsValue);
		if (pointsValue !== "" && parsed === null) return;
		setSavingPoints(true);
		try {
			await apiFetch(`/api/issues/${issueId}`, {
				workspaceSlug,
				method: "PATCH",
				body: { customFields: { story_points: parsed === null ? null : String(parsed) } },
			});
			await fetchIssue();
		} catch {
			// non-fatal — revert display via fetchIssue
		} finally {
			setSavingPoints(false);
			setEditingPoints(false);
		}
	}

	if (editingPoints) {
		return (
			<span class="inline-flex items-center gap-1">
				<input
					type="number"
					value={pointsValue}
					onInput={(e) => setPointsValue((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") savePoints();
						if (e.key === "Escape") setEditingPoints(false);
					}}
					onBlur={savePoints}
					disabled={savingPoints}
					// biome-ignore lint/a11y/noAutofocus: intentional focus when the inline editor opens
					autoFocus
					class="w-16 px-[0.375rem] py-[0.125rem] border border-border rounded text-[0.8rem]
						text-center bg-bg text-text-base"
				/>
				<span class="text-xs text-text-muted">pts</span>
			</span>
		);
	}

	return (
		<button
			type="button"
			onClick={startEditPoints}
			title="Edit story points"
			class="inline-flex items-center gap-1.5 text-sm text-text-base hover:text-accent
				transition-colors cursor-pointer bg-transparent border-none p-0 text-left"
		>
			<span>{storyPointsValue ? `${storyPointsValue} pts` : "—"}</span>
			<span class="text-text-muted">
				<PencilIcon />
			</span>
		</button>
	);
}

export function SidebarPanel({
	issue,
	issueId,
	workspaceSlug,
	statuses,
	taskTypes,
	members,
	updatingStatus,
	updatingPriority,
	updatingAssignee,
	updatingType,
	changeStatus,
	changePriority,
	changeAssignee,
	changeType,
	fetchIssue,
}: {
	issue: IssueData;
	issueId: string;
	workspaceSlug?: string;
	statuses: TaskStatus[];
	taskTypes: TaskType[];
	members: Member[];
	updatingStatus: boolean;
	updatingPriority: boolean;
	updatingAssignee: boolean;
	updatingType: boolean;
	changeStatus: (statusId: string) => void;
	changePriority: (priority: string) => void;
	changeAssignee: (assigneeId: string) => void;
	changeType: (typeId: string) => void;
	fetchIssue: () => Promise<void>;
}) {
	const priorityStyle = PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS.none;
	const storyPointsField = (issue.customFields ?? []).find((f) => f.key === "story_points");

	return (
		<div class="w-[240px] shrink-0 max-sm:w-full sticky top-4 self-start">
			<div class="rounded-lg border border-border bg-surface px-4 py-2 divide-y divide-[var(--border)]">
				<SidebarField label="Status">
					<StatusField
						issue={issue}
						statuses={statuses}
						updatingStatus={updatingStatus}
						changeStatus={changeStatus}
					/>
				</SidebarField>

				<SidebarField label="Type">
					<TypeField
						issue={issue}
						taskTypes={taskTypes}
						updatingType={updatingType}
						changeType={changeType}
					/>
				</SidebarField>

				<SidebarField label="Priority">
					<Select
						ariaLabel="Change priority"
						value={issue.priority}
						disabled={updatingPriority}
						capitalize
						onChange={(v) => changePriority(v)}
						options={PRIORITY_OPTIONS}
						buttonStyle={{
							color: priorityStyle.text,
							background: priorityStyle.bg,
							fontWeight: 500,
							borderColor: "transparent",
						}}
					/>
				</SidebarField>

				<SidebarField label="Assignee">
					{members.length > 0 ? (
						<Select
							ariaLabel="Change assignee"
							value={issue.assignee_id ?? ""}
							disabled={updatingAssignee}
							onChange={changeAssignee}
							options={[
								{ value: "", label: "Unassigned" },
								...members.map((m) => ({ value: m.id, label: m.name ?? m.email })),
							]}
						/>
					) : (
						<span class="text-sm text-text-base">{issue.assignee_name ?? "—"}</span>
					)}
				</SidebarField>

				<SidebarField label="Points">
					<PointsField
						issueId={issueId}
						workspaceSlug={workspaceSlug}
						storyPointsValue={storyPointsField?.value ?? ""}
						fetchIssue={fetchIssue}
					/>
				</SidebarField>

				{issue.project_name && (
					<SidebarField label="Project">
						<span class="text-sm text-text-base">
							{issue.project_name}
							{issue.project_key && <span class="text-text-muted"> ({issue.project_key})</span>}
						</span>
					</SidebarField>
				)}

				<SidebarField label="Created">
					<span class="text-sm text-text-base">{formatDate(issue.created_at)}</span>
				</SidebarField>

				<SidebarField label="Updated">
					<span class="text-sm text-text-base">{formatDate(issue.updated_at)}</span>
				</SidebarField>
			</div>
		</div>
	);
}
