import { useState } from "preact/hooks";
import { formatIssueRef, isValidIssueRef, normalizeIssueRef } from "../lib/issue-ref";
import { parseStoryPoints } from "../lib/story-points";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import { PRIORITY_OPTIONS } from "../utils/issue-utils";
import { renderMd } from "../utils/markdown";
import { categoryColor } from "./board-utils";
import type {
	Attachment,
	Comment,
	IssueData,
	IssueLink,
	Member,
	TaskStatus,
} from "./issue-detail-helpers";
import {
	formatBytes,
	formatDate,
	LINK_TYPE_LABELS,
	LINK_TYPE_OPTIONS,
	PRIORITY_COLORS,
	relativeTime,
} from "./issue-detail-helpers";
import MarkdownEditor from "./MarkdownEditor";
import Select from "./Select";

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
		<span
			class="font-mono text-xs font-semibold px-2 py-[0.2rem] rounded bg-surface border
				border-border text-text-muted inline-flex items-center gap-1.5"
		>
			{issueRef}
			<button
				type="button"
				onClick={copyLink}
				title={copiedRef ? "Copied!" : "Copy link"}
				class="text-text-muted hover:text-text-base transition-colors leading-none"
			>
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
		</span>
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
			<button
				type="button"
				onClick={createShareLink}
				disabled={sharingLoading}
				class="btn btn-outline btn-sm"
				title="Share issue"
			>
				{sharingLoading ? "…" : "Share"}
			</button>
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
						<button
							type="button"
							onClick={copyShareUrl}
							class="btn btn-outline btn-sm shrink-0"
							title={copiedShare ? "Copied!" : "Copy"}
						>
							{copiedShare ? "✓" : "Copy"}
						</button>
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
					<button
						type="button"
						onClick={saveTitle}
						disabled={savingTitle}
						class="btn btn-primary btn-sm"
					>
						{savingTitle ? "Saving…" : "Save"}
					</button>
					<button
						type="button"
						onClick={cancelEditTitle}
						disabled={savingTitle}
						class="btn btn-outline btn-sm"
					>
						Cancel
					</button>
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
	const [editingBody, setEditingBody] = useState(false);
	const [editBody, setEditBody] = useState("");
	const [savingBody, setSavingBody] = useState(false);
	const [saveBodyError, setSaveBodyError] = useState<string | null>(null);

	function startEditBody() {
		setEditBody(issue.body ?? "");
		setSaveBodyError(null);
		setEditingBody(true);
	}

	function cancelEditBody() {
		setEditingBody(false);
		setSaveBodyError(null);
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
			await fetchIssue();
			setEditingBody(false);
		} catch (e) {
			setSaveBodyError(`Save failed: ${String(e)}`);
		} finally {
			setSavingBody(false);
		}
	}

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
						onClick={startEditBody}
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

			{editingBody ? (
				<div>
					<div class="mb-2">
						<MarkdownEditor value={editBody} onChange={setEditBody} minHeight="240px" />
					</div>
					<div class="flex gap-2">
						<button type="button" onClick={saveBody} disabled={savingBody} class="btn btn-primary">
							{savingBody ? "Saving…" : "Save"}
						</button>
						<button
							type="button"
							onClick={cancelEditBody}
							disabled={savingBody}
							class="btn btn-outline"
						>
							Cancel
						</button>
					</div>
				</div>
			) : issue.body ? (
				<div
					class="prose prose-sm max-w-none"
					dangerouslySetInnerHTML={{ __html: renderMd(issue.body) }}
				/>
			) : (
				<p class="text-text-muted italic">No description.</p>
			)}
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
						class="px-[0.375rem] py-[0.0625rem] rounded-[3px] text-[0.7rem] bg-[rgba(107,114,128,0.12)] font-medium"
						style={{ color: categoryColor(link.linkedIssueStatusCategory) }}
					>
						{link.linkedIssueStatusCategory.replace("_", " ")}
					</span>
				)}
			</a>
			<button
				type="button"
				onClick={onRemove}
				aria-label={`Remove ${ref} link`}
				class="btn btn-sm bg-transparent border-none text-text-muted px-[0.125rem] leading-none"
			>
				×
			</button>
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
			<button type="button" onClick={onAdd} disabled={addingLink} class="btn btn-primary">
				{addingLink ? "Adding…" : "Add"}
			</button>
			<button type="button" onClick={onCancel} class="btn btn-outline">
				Cancel
			</button>
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
				onClick={onDelete}
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
	const [uploadFormOpen, setUploadFormOpen] = useState(false);
	const [uploadFile, setUploadFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);

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
			setUploadFile(null);
			setUploadFormOpen(false);
			await fetchAttachments();
		} catch (e) {
			setUploadError(String(e));
		} finally {
			setUploading(false);
		}
	}

	async function deleteAttachment(attachmentId: string) {
		try {
			await apiFetch(`/api/files/${attachmentId}`, { workspaceSlug, method: "DELETE" });
			await fetchAttachments();
		} catch {
			// non-fatal
		}
	}

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

			{uploadFormOpen ? (
				<AttachmentUploadForm
					uploadFile={uploadFile}
					setUploadFile={setUploadFile}
					uploadError={uploadError}
					setUploadError={setUploadError}
					uploading={uploading}
					onUpload={uploadAttachment}
					onCancel={() => {
						setUploadFormOpen(false);
						setUploadFile(null);
						setUploadError(null);
					}}
				/>
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
							<button type="button" onClick={onStartEdit} class="btn btn-outline btn-sm">
								Edit
							</button>
							<button
								type="button"
								onClick={onDelete}
								class="btn btn-sm bg-transparent border border-[var(--danger-text)] text-[var(--danger-text)]"
							>
								Delete
							</button>
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
						<button type="button" onClick={onSave} disabled={saving} class="btn btn-primary">
							{saving ? "Saving…" : "Save"}
						</button>
						<button type="button" onClick={onCancelEdit} disabled={saving} class="btn btn-outline">
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div
					class="prose prose-sm max-w-none"
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
			setNewComment("");
			await fetchComments();
		} catch (e) {
			setCommentError(`Failed to post comment: ${String(e)}`);
		} finally {
			setPostingComment(false);
		}
	}

	return { newComment, setNewComment, postingComment, commentError, submitComment };
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
					class="w-full px-3 py-2 border border-border rounded text-sm resize-y box-border mb-2 bg-bg text-text-base"
				/>
				<button
					type="submit"
					disabled={postingComment || !newComment.trim()}
					class="btn btn-primary max-sm:w-full min-h-[44px]"
				>
					{postingComment ? "Posting…" : "Comment"}
				</button>
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
	members,
	updatingStatus,
	updatingPriority,
	updatingAssignee,
	changeStatus,
	changePriority,
	changeAssignee,
	fetchIssue,
}: {
	issue: IssueData;
	issueId: string;
	workspaceSlug?: string;
	statuses: TaskStatus[];
	members: Member[];
	updatingStatus: boolean;
	updatingPriority: boolean;
	updatingAssignee: boolean;
	changeStatus: (statusId: string) => void;
	changePriority: (priority: string) => void;
	changeAssignee: (assigneeId: string) => void;
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
