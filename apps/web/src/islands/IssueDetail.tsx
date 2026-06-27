import { useCallback, useEffect, useState } from "preact/hooks";
import { formatIssueRef, isValidIssueRef, normalizeIssueRef } from "../lib/issue-ref";
import { parseStoryPoints } from "../lib/story-points";
import { apiFetch } from "../utils/api-client";
import { renderMd } from "../utils/markdown";
import { issueUrl } from "../utils/issue-url";
import { PRIORITY_OPTIONS } from "../utils/issue-utils";
import Select from "./Select";
import MarkdownEditor from "./MarkdownEditor";
import { categoryColor } from "./board-utils";

interface TaskStatus {
	id: string;
	key: string;
	name: string;
	category: string;
	color: string | null;
}

interface CustomFieldValue {
	key: string;
	label: string;
	type: string;
	value: string;
}

interface IssueLink {
	id: string;
	type: "blocks" | "blocked_by" | "relates_to" | "duplicates";
	linkedIssueId: string;
	linkedIssueTitle: string;
	linkedIssueNumber: number;
	linkedIssueProjectKey: string;
	linkedIssueStatusCategory: string;
	createdById: string;
	createdAt: number;
}

interface Attachment {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	createdAt: number;
}

interface IssueData {
	id: string;
	number: number;
	title: string;
	body: string | null;
	priority: string;
	assignee_id: string | null;
	assignee_name: string | null;
	parent_id: string | null;
	project_key: string | null;
	project_name: string | null;
	type_key: string | null;
	type_name: string | null;
	status_id: string | null;
	status_key: string | null;
	status_name: string | null;
	status_category: string | null;
	created_at: number;
	updated_at: number;
	customFields: CustomFieldValue[];
	rollup?: { total: number; done: number; remaining: number; byStatus: Record<string, number> };
}

interface Comment {
	id: string;
	body: string;
	author_id: string;
	author_name: string;
	author_email: string;
	created_at: number;
}

interface Member {
	id: string;
	name: string | null;
	email: string;
}

interface Props {
	issueId?: string;
	issueNumber?: number;
	projectSlug?: string;
	workspaceSlug?: string;
}

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
	urgent: { bg: "var(--priority-urgent-bg)", text: "var(--priority-urgent-text)" },
	high: { bg: "var(--priority-high-bg)", text: "var(--priority-high-text)" },
	medium: { bg: "var(--priority-medium-bg)", text: "var(--priority-medium-text)" },
	low: { bg: "var(--priority-low-bg)", text: "var(--priority-low-text)" },
	none: { bg: "var(--priority-none-bg)", text: "var(--priority-none-text)" },
};

const LINK_TYPE_LABELS: Record<string, string> = {
	blocks: "Blocks",
	blocked_by: "Blocked by",
	relates_to: "Relates to",
	duplicates: "Duplicates",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function relativeTime(unixSeconds: number): string {
	const diff = Date.now() / 1000 - unixSeconds;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
	return formatDate(unixSeconds);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LINK_TYPE_OPTIONS = [
	{ value: "relates_to", label: "Relates to" },
	{ value: "blocks", label: "Blocks" },
	{ value: "blocked_by", label: "Blocked by" },
	{ value: "duplicates", label: "Duplicates" },
];

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

export default function IssueDetail({ issueId: issueIdProp, issueNumber, projectSlug, workspaceSlug }: Props) {
	const [issueId, setIssueId] = useState(issueIdProp ?? "");
	const [issue, setIssue] = useState<IssueData | null>(null);
	const [comments, setComments] = useState<Comment[]>([]);
	const [statuses, setStatuses] = useState<TaskStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!issueIdProp) {
			setIssueId(new URLSearchParams(window.location.search).get("id") ?? "");
		}
	}, [issueIdProp]);

	// Resolve issueNumber+projectSlug to UUID via the KEY-NUMBER API format (e.g. PROJ-42)
	useEffect(() => {
		if (issueIdProp || !projectSlug || issueNumber === undefined) return;
		apiFetch<{ id: string }>(`/api/issues/${projectSlug}-${issueNumber}`, { workspaceSlug })
			.then((data) => setIssueId(data.id))
			.catch((e) => setError(String(e)));
	}, [issueIdProp, projectSlug, issueNumber, workspaceSlug]);

	// When served as fallback for pretty-URL issue routes (/projects/KEY/issues/N/title),
	// extract KEY and N from the pathname and resolve to a UUID via the API.
	useEffect(() => {
		if (issueIdProp || projectSlug || issueNumber !== undefined) return;
		const m = window.location.pathname.match(/^\/projects\/([^/]+)\/issues\/(\d+)\//);
		if (!m) return;
		apiFetch<{ id: string }>(`/api/issues/${m[1]}-${m[2]}`, { workspaceSlug })
			.then((data) => setIssueId(data.id))
			.catch((e) => setError(String(e)));
	}, [issueIdProp, projectSlug, issueNumber, workspaceSlug]);

	useEffect(() => {
		try {
			const ref = document.referrer;
			if (!ref) return;
			const url = new URL(ref);
			if (url.pathname.startsWith("/issues") && url.search) {
				setBackHref(url.pathname + url.search);
			}
		} catch {
			// ignore — invalid referrer
		}
	}, []);

	// Title editing
	const [editingTitle, setEditingTitle] = useState(false);
	const [editTitle, setEditTitle] = useState("");
	const [savingTitle, setSavingTitle] = useState(false);
	const [saveTitleError, setSaveTitleError] = useState<string | null>(null);

	// Body editing
	const [editingBody, setEditingBody] = useState(false);
	const [editBody, setEditBody] = useState("");
	const [savingBody, setSavingBody] = useState(false);
	const [saveBodyError, setSaveBodyError] = useState<string | null>(null);

	// Members for assignee selector
	const [members, setMembers] = useState<Member[]>([]);

	// Status updating
	const [updatingStatus, setUpdatingStatus] = useState(false);

	// Priority updating
	const [updatingPriority, setUpdatingPriority] = useState(false);

	// Assignee updating
	const [updatingAssignee, setUpdatingAssignee] = useState(false);

	// Story points
	const [editingPoints, setEditingPoints] = useState(false);
	const [pointsValue, setPointsValue] = useState("");
	const [savingPoints, setSavingPoints] = useState(false);

	// Current user (for comment ownership)
	const [currentUserId, setCurrentUserId] = useState<string | null>(null);

	// Comment form
	const [newComment, setNewComment] = useState("");
	const [postingComment, setPostingComment] = useState(false);
	const [commentError, setCommentError] = useState<string | null>(null);

	// Comment editing
	const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
	const [editCommentBody, setEditCommentBody] = useState("");
	const [savingComment, setSavingComment] = useState(false);
	const [editCommentError, setEditCommentError] = useState<string | null>(null);

	// Epic parent badge
	const [parentEpic, setParentEpic] = useState<IssueData | null>(null);

	// Child issues (only populated when issue is an epic)
	const [childIssues, setChildIssues] = useState<IssueData[]>([]);

	// Relations
	const [links, setLinks] = useState<IssueLink[]>([]);
	const [fetchingLinks, setFetchingLinks] = useState(false);
	const [linkFormOpen, setLinkFormOpen] = useState(false);
	const [linkFormType, setLinkFormType] = useState<string>("relates_to");
	const [linkFormRef, setLinkFormRef] = useState("");
	const [addingLink, setAddingLink] = useState(false);
	const [linkFormError, setLinkFormError] = useState<string | null>(null);

	// Attachments
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [uploadFormOpen, setUploadFormOpen] = useState(false);
	const [uploadFile, setUploadFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);

	// Back-navigation href — preserved from referrer if user came from a filtered issues list
	const [backHref, setBackHref] = useState<string | null>(null);

	// Copy-link feedback
	const [copiedRef, setCopiedRef] = useState(false);

	// Share link popover
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [sharingLoading, setSharingLoading] = useState(false);
	const [copiedShare, setCopiedShare] = useState(false);

	const fetchIssue = useCallback(async () => {
		try {
			const data = await apiFetch<IssueData>(`/api/issues/${issueId}`, { workspaceSlug });
			setIssue(data);
		} catch (e) {
			setError(String(e));
		}
	}, [issueId, workspaceSlug]);

	const fetchComments = useCallback(async () => {
		try {
			const data = await apiFetch<Comment[]>(`/api/issues/${issueId}/comments`, { workspaceSlug });
			setComments(Array.isArray(data) ? data : []);
		} catch {
			// non-fatal
		}
	}, [issueId, workspaceSlug]);

	const fetchLinks = useCallback(async () => {
		if (!issueId) return;
		setFetchingLinks(true);
		try {
			const data = await apiFetch<IssueLink[]>(`/api/issues/${issueId}/links`, { workspaceSlug });
			setLinks(Array.isArray(data) ? data : []);
		} catch {
			// non-fatal
		} finally {
			setFetchingLinks(false);
		}
	}, [issueId, workspaceSlug]);

	const fetchAttachments = useCallback(async () => {
		if (!issueId) return;
		try {
			const qs = new URLSearchParams({ entityType: "issue", entityId: issueId });
			const data = await apiFetch<Attachment[]>(`/api/files?${qs}`, { workspaceSlug });
			setAttachments(Array.isArray(data) ? data : []);
		} catch {
			// non-fatal
		}
	}, [issueId, workspaceSlug]);

	useEffect(() => {
		if (!issue) return;

		// Silently update address bar to canonical pretty URL when arriving via UUID fallback
		if (issue.project_key) {
			const canonical = issueUrl(issue.project_key, issue.number, issue.title, issue.id);
			history.replaceState(null, "", canonical);
		}

		// Fetch parent issue (any type — not just epics)
		if (issue.parent_id) {
			apiFetch<IssueData>(`/api/issues/${issue.parent_id}`, { workspaceSlug })
				.then((parent) => setParentEpic(parent ?? null))
				.catch(() => {});
		} else {
			setParentEpic(null);
		}

		// Fetch child issues if this issue is an epic
		if (issue.type_key === "epic") {
			const qs = new URLSearchParams({ parentId: issue.id });
			if (workspaceSlug) qs.set("workspace", workspaceSlug);
			apiFetch<{ items: IssueData[] }>(`/api/issues?${qs}`, { workspaceSlug })
				.then((data) => {
					const items = data?.items ?? [];
					setChildIssues([...items].sort((a, b) => a.number - b.number));
				})
				.catch(() => {});
		} else {
			setChildIssues([]);
		}
	}, [issue, workspaceSlug]);

	useEffect(() => {
		if (!issueId) return;
		setLoading(true);
		setError(null);
		Promise.all([
			fetchIssue(),
			fetchComments(),
			fetchLinks(),
			fetchAttachments(),
			(async () => {
				try {
					const data = await apiFetch<TaskStatus[]>("/api/task-statuses", { workspaceSlug });
					if (Array.isArray(data)) setStatuses(data);
				} catch {
					// non-fatal
				}
			})(),
			(async () => {
				try {
					const data = await apiFetch<{ user: { id: string } }>("/auth/me", { workspaceSlug });
					setCurrentUserId(data.user.id);
				} catch {
					// non-fatal — edit/delete buttons simply won't show
				}
			})(),
			(async () => {
				if (!workspaceSlug) return;
				try {
					const data = await apiFetch<{ members: Member[] }>(`/api/workspaces/${workspaceSlug}`, { workspaceSlug });
					if (Array.isArray(data?.members)) setMembers(data.members);
				} catch {
					// non-fatal — assignee field falls back to display-only
				}
			})(),
		]).finally(() => setLoading(false));
	}, [fetchIssue, fetchComments, fetchLinks, fetchAttachments, workspaceSlug]);

	async function changeStatus(statusId: string) {
		if (!issue) return;
		const status = statuses.find((s) => s.id === statusId);
		if (!status) return;

		setIssue((prev) =>
			prev
				? {
						...prev,
						status_id: status.id,
						status_key: status.key,
						status_name: status.name,
						status_category: status.category,
					}
				: prev
		);

		setUpdatingStatus(true);
		try {
			await apiFetch(`/api/issues/${issueId}`, { workspaceSlug, method: "PATCH", body: { statusId } });
		} catch {
			await fetchIssue();
		} finally {
			setUpdatingStatus(false);
		}
	}

	async function changePriority(priority: string) {
		if (!issue) return;

		setIssue((prev) => (prev ? { ...prev, priority } : prev));

		setUpdatingPriority(true);
		try {
			await apiFetch(`/api/issues/${issueId}`, { workspaceSlug, method: "PATCH", body: { priority } });
		} catch {
			await fetchIssue();
		} finally {
			setUpdatingPriority(false);
		}
	}

	async function changeAssignee(assigneeId: string) {
		if (!issue) return;
		const member = members.find((m) => m.id === assigneeId) ?? null;

		setIssue((prev) =>
			prev
				? { ...prev, assignee_id: assigneeId || null, assignee_name: member?.name ?? member?.email ?? null }
				: prev
		);

		setUpdatingAssignee(true);
		try {
			await apiFetch(`/api/issues/${issueId}`, {
				workspaceSlug,
				method: "PATCH",
				body: { assigneeId: assigneeId || null },
			});
		} catch {
			await fetchIssue();
		} finally {
			setUpdatingAssignee(false);
		}
	}

	function startEditTitle() {
		if (!issue) return;
		setEditTitle(issue.title);
		setSaveTitleError(null);
		setEditingTitle(true);
	}

	function cancelEditTitle() {
		setEditingTitle(false);
		setSaveTitleError(null);
	}

	async function saveTitle() {
		if (!issue || !editTitle.trim()) return;
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

	function startEditBody() {
		if (!issue) return;
		setEditBody(issue.body ?? "");
		setSaveBodyError(null);
		setEditingBody(true);
	}

	function cancelEditBody() {
		setEditingBody(false);
		setSaveBodyError(null);
	}

	async function saveBody() {
		if (!issue) return;
		setSavingBody(true);
		setSaveBodyError(null);
		try {
			await apiFetch(`/api/issues/${issueId}`, { workspaceSlug, method: "PATCH", body: { body: editBody } });
			await fetchIssue();
			setEditingBody(false);
		} catch (e) {
			setSaveBodyError(`Save failed: ${String(e)}`);
		} finally {
			setSavingBody(false);
		}
	}

	function startEditPoints(currentValue: string) {
		setPointsValue(currentValue);
		setEditingPoints(true);
	}

	async function savePoints() {
		if (!issue) return;
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
			// Resolve the ref to an issue ID
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
			await apiFetch(`/api/issues/${issueId}/comments/${commentId}`, { workspaceSlug, method: "DELETE" });
			await fetchComments();
		} catch {
			// non-fatal
		}
	}

	function copyLink() {
		if (!issue) return;
		const canonical = issueUrl(issue.project_key, issue.number, issue.title, issue.id);
		const absoluteUrl = new URL(canonical, window.location.origin).href;
		navigator.clipboard.writeText(absoluteUrl).catch(() => {});
		setCopiedRef(true);
		setTimeout(() => setCopiedRef(false), 2000);
	}

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

	if (!issueId)
		return (
			<p class="text-text-muted">
				No issue ID provided. Add <code>?id=…</code> to the URL.
			</p>
		);
	if (loading) return <p aria-live="polite">Loading…</p>;
	if (error)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load issue: {error}
			</p>
		);
	if (!issue) return null;

	const issueRef = formatIssueRef(issue.project_key, issue.number);
	const priorityStyle = PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS.none;
	const storyPointsField = (issue.customFields ?? []).find((f) => f.key === "story_points");
	const blockedByLinks = links.filter((l) => l.type === "blocked_by");
	const linksByType = (["blocked_by", "blocks", "relates_to", "duplicates"] as const)
		.map((type) => ({
			type,
			label: LINK_TYPE_LABELS[type],
			items: links.filter((l) => l.type === type),
		}))
		.filter((g) => g.items.length > 0);

	return (
		<article class="max-w-[900px] mx-auto">
			{/* Breadcrumb */}
			<nav class="text-sm text-text-muted mb-5">
				<a href={backHref ?? `/issues${issue.project_key ? `?project=${issue.project_key}` : ""}`} class="text-text-muted no-underline">
					← Issues
				</a>
			</nav>

			{/* Blocked-by banner */}
			{blockedByLinks.length > 0 && (
				<div
					role="alert"
					class="mb-4 px-[0.875rem] py-2 bg-[rgba(251,191,36,0.12)] border border-[rgba(251,191,36,0.5)] rounded-md text-sm text-text-base flex items-center gap-2"
				>
					<span>⚠</span>
					<span>
						Blocked by {blockedByLinks.length} issue{blockedByLinks.length > 1 ? "s" : ""}
					</span>
				</div>
			)}

			{/* Issue header */}
			<header class="mb-6">
				<div class="flex items-center gap-2 mb-3 flex-wrap">
					{/* Ref chip with copy-link button */}
					<span class="font-mono text-xs font-semibold px-2 py-[0.2rem] rounded bg-surface border border-border text-text-muted inline-flex items-center gap-1.5">
						{issueRef}
						<button
							type="button"
							onClick={copyLink}
							title={copiedRef ? "Copied!" : "Copy link"}
							class="text-text-muted hover:text-text-base transition-colors leading-none"
						>
							{copiedRef ? (
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="20 6 9 17 4 12" />
								</svg>
							) : (
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
									<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
								</svg>
							)}
						</button>
					</span>
					{/* Share button + popover */}
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
							<div class="absolute left-0 top-full mt-1 z-50 bg-[var(--bg)] border border-border rounded-md shadow-[var(--shadow-sm)] p-3 w-72">
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
					{/* Type badge */}
					{issue.type_name && (
						<span class="inline-flex items-center px-2 py-[0.125rem] rounded bg-surface border border-border text-xs font-medium text-text-muted">
							{issue.type_name}
						</span>
					)}
					{/* Parent badge */}
					{parentEpic && (
						<a
							href={issueUrl(parentEpic.project_key, parentEpic.number, parentEpic.title, parentEpic.id)}
							class={`inline-flex items-center gap-1 px-2 py-[0.125rem] rounded no-underline text-xs font-medium border ${parentEpic.type_key === "epic" ? "bg-[var(--epic-bg)] text-[var(--epic-text)] border-[var(--epic-border)]" : "bg-surface text-text-muted border-border"}`}
						>
							<span>{parentEpic.type_key === "epic" ? "⬡" : "↑"}</span>
							<span>
								{parentEpic.type_name ?? "Parent"}:{" "}
								{parentEpic.project_key
									? `${parentEpic.project_key}-${parentEpic.number}`
									: `#${parentEpic.number}`}{" "}
								{parentEpic.title}
							</span>
						</a>
					)}
				</div>

				{/* Title — click or pencil icon to edit */}
				{editingTitle ? (
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
							autoFocus
							class="w-full text-2xl font-bold text-text-base bg-bg border border-border rounded-md px-3 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
						/>
						<div class="flex gap-2">
							<button type="button" onClick={saveTitle} disabled={savingTitle} class="btn btn-primary btn-sm">
								{savingTitle ? "Saving…" : "Save"}
							</button>
							<button type="button" onClick={cancelEditTitle} disabled={savingTitle} class="btn btn-outline btn-sm">
								Cancel
							</button>
						</div>
					</div>
				) : (
					<div class="group flex items-start gap-2">
						<h1
							class="m-0 text-2xl font-bold text-text-base leading-tight cursor-pointer"
							onClick={startEditTitle}
							title="Click to edit title"
						>
							{issue.title}
						</h1>
						<button
							type="button"
							onClick={startEditTitle}
							title="Edit title"
							class="shrink-0 mt-[0.35rem] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:text-text-base"
						>
							<PencilIcon />
						</button>
					</div>
				)}
			</header>

			{/* Two-column body */}
			<div class="flex gap-8 items-start max-sm:flex-col">

				{/* ── Main column ── */}
				<div class="flex-1 min-w-0">

					{/* Description */}
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
									<button type="button" onClick={cancelEditBody} disabled={savingBody} class="btn btn-outline">
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

					{/* Child issues — only shown when this issue is an epic */}
					{issue.type_key === "epic" && (
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
												<span class="font-mono text-[0.8rem] text-text-muted shrink-0">
													{childRef}
												</span>
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
					)}

					{/* Relations */}
					<section class="mb-8">
						<SectionDivider title={`Relations${links.length > 0 ? ` (${links.length})` : ""}`} />

						{fetchingLinks && links.length === 0 && (
							<p class="text-text-muted text-sm">Loading…</p>
						)}

						{linksByType.length > 0 && (
							<div class="mb-4">
								{linksByType.map((group) => (
									<div key={group.type} class="mb-3">
										<p class="m-0 mb-[0.375rem] text-xs font-semibold text-text-muted uppercase tracking-[0.04em]">
											{group.label}
										</p>
										<div class="flex flex-wrap gap-2">
											{group.items.map((link) => {
												const ref = formatIssueRef(link.linkedIssueProjectKey, link.linkedIssueNumber);
												return (
													<span
														key={link.id}
														class="inline-flex items-center gap-[0.375rem] px-2 py-1 border border-border rounded-md bg-surface text-[0.8rem]"
													>
														<a
															href={issueUrl(link.linkedIssueProjectKey, link.linkedIssueNumber, link.linkedIssueTitle, link.linkedIssueId)}
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
															onClick={() => removeLink(link.id)}
															aria-label={`Remove ${ref} link`}
															class="btn btn-sm bg-transparent border-none text-text-muted px-[0.125rem] leading-none"
														>
															×
														</button>
													</span>
												);
											})}
										</div>
									</div>
								))}
							</div>
						)}

						{linkFormOpen ? (
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
										if (e.key === "Enter") addLink();
										if (e.key === "Escape") setLinkFormOpen(false);
									}}
									placeholder="PROJ-12"
									autoFocus
									class="px-[0.625rem] py-[0.375rem] border border-border rounded text-sm w-28 max-sm:w-full bg-bg text-text-base"
								/>
								<button type="button" onClick={addLink} disabled={addingLink} class="btn btn-primary">
									{addingLink ? "Adding…" : "Add"}
								</button>
								<button type="button" onClick={() => setLinkFormOpen(false)} class="btn btn-outline">
									Cancel
								</button>
								{linkFormError && (
									<span role="alert" class="text-[0.8rem] text-[var(--danger-text)] self-center">
										{linkFormError}
									</span>
								)}
							</div>
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

					{/* Attachments */}
					<section class="mb-8">
						<SectionDivider title={`Attachments${attachments.length > 0 ? ` (${attachments.length})` : ""}`} />

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
									onClick={() => { setUploadFormOpen(false); setUploadFile(null); setUploadError(null); }}
									class="btn btn-outline"
								>
									Cancel
								</button>
								{uploadError && (
									<span role="alert" class="text-[0.8rem] text-[var(--danger-text)] self-center">
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
					</section>

					{/* Comments */}
					<section>
						<SectionDivider title={`Comments${comments.length > 0 ? ` (${comments.length})` : ""}`} />

						{comments.length === 0 ? (
							<p class="text-text-muted mb-4">No comments yet.</p>
						) : (
							<div class="mb-6">
								{comments.map((c) => (
									<div
										key={c.id}
										class="px-4 py-3 border border-border rounded-lg mb-3 bg-surface shadow-[var(--shadow-sm)]"
									>
										<div class="flex justify-between mb-[0.375rem]">
											<span class="font-semibold text-sm text-text-base">
												{c.author_name || c.author_email}
											</span>
											<div class="flex items-center gap-2">
												<span class="text-xs text-text-muted" title={formatDate(c.created_at)}>
													{relativeTime(c.created_at)}
												</span>
												{currentUserId && c.author_id === currentUserId && editingCommentId !== c.id && (
													<>
														<button
															type="button"
															onClick={() => startEditComment(c)}
															class="btn btn-outline btn-sm"
														>
															Edit
														</button>
														<button
															type="button"
															onClick={() => doDeleteComment(c.id)}
															class="btn btn-sm bg-transparent border border-[var(--danger-text)] text-[var(--danger-text)]"
														>
															Delete
														</button>
													</>
												)}
											</div>
										</div>
										{editingCommentId === c.id ? (
											<div>
												{editCommentError && (
													<p role="alert" class="text-[var(--danger-text)] mb-2 text-sm">
														{editCommentError}
													</p>
												)}
												<textarea
													value={editCommentBody}
													onInput={(e) => setEditCommentBody((e.target as HTMLTextAreaElement).value)}
													rows={4}
													class="w-full px-3 py-2 border border-border rounded text-sm resize-y box-border mb-2 bg-bg text-text-base"
												/>
												<div class="flex gap-2">
													<button
														type="button"
														onClick={() => saveEditComment(c.id)}
														disabled={savingComment}
														class="btn btn-primary"
													>
														{savingComment ? "Saving…" : "Save"}
													</button>
													<button
														type="button"
														onClick={cancelEditComment}
														disabled={savingComment}
														class="btn btn-outline"
													>
														Cancel
													</button>
												</div>
											</div>
										) : (
											<div
												class="prose prose-sm max-w-none"
												dangerouslySetInnerHTML={{ __html: renderMd(c.body) }}
											/>
										)}
									</div>
								))}
							</div>
						)}

						{/* Add comment form */}
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
				</div>

				{/* ── Sidebar ── */}
				<div class="w-[240px] shrink-0 max-sm:w-full sticky top-4 self-start">
					<div class="rounded-lg border border-border bg-surface px-4 py-2 divide-y divide-[var(--border)]">

						{/* Status */}
						<SidebarField label="Status">
							{statuses.length > 0 ? (
								<Select
									ariaLabel="Change status"
									value={issue.status_id ?? ""}
									disabled={updatingStatus}
									onChange={(v) => changeStatus(v)}
									options={statuses.map((s) => ({ value: s.id, label: s.name }))}
									buttonStyle={{ color: categoryColor(issue.status_category), fontWeight: 500 }}
								/>
							) : issue.status_name ? (
								<span
									class="text-sm font-medium"
									style={{ color: categoryColor(issue.status_category) }}
								>
									{issue.status_name}
								</span>
							) : (
								<span class="text-sm text-text-muted">—</span>
							)}
						</SidebarField>

						{/* Priority */}
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

						{/* Assignee */}
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

						{/* Story points */}
						<SidebarField label="Points">
							{editingPoints ? (
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
										autoFocus
										class="w-16 px-[0.375rem] py-[0.125rem] border border-border rounded text-[0.8rem] text-center bg-bg text-text-base"
									/>
									<span class="text-xs text-text-muted">pts</span>
								</span>
							) : (
								<button
									type="button"
									onClick={() => startEditPoints(storyPointsField?.value ?? "")}
									title="Edit story points"
									class="inline-flex items-center gap-1.5 text-sm text-text-base hover:text-accent transition-colors cursor-pointer bg-transparent border-none p-0 text-left"
								>
									<span>{storyPointsField ? `${storyPointsField.value} pts` : "—"}</span>
									<span class="text-text-muted">
										<PencilIcon />
									</span>
								</button>
							)}
						</SidebarField>

						{/* Project */}
						{issue.project_name && (
							<SidebarField label="Project">
								<span class="text-sm text-text-base">
									{issue.project_name}
									{issue.project_key && (
										<span class="text-text-muted"> ({issue.project_key})</span>
									)}
								</span>
							</SidebarField>
						)}

						{/* Created */}
						<SidebarField label="Created">
							<span class="text-sm text-text-base">{formatDate(issue.created_at)}</span>
						</SidebarField>

						{/* Updated */}
						<SidebarField label="Updated">
							<span class="text-sm text-text-base">{formatDate(issue.updated_at)}</span>
						</SidebarField>

					</div>
				</div>
			</div>
		</article>
	);
}
