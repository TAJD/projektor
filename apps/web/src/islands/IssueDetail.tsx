import { useCallback, useEffect, useState } from "preact/hooks";
import { formatIssueRef } from "../lib/issue-ref";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import {
	AttachmentsSection,
	BodySection,
	ChildIssuesSection,
	CommentsSection,
	ParentBadge,
	RefChip,
	RelationsSection,
	ShareButton,
	SidebarPanel,
	TitleSection,
} from "./IssueDetailParts";
import type {
	Attachment,
	Comment,
	IssueData,
	IssueLink,
	Member,
	TaskStatus,
} from "./issue-detail-helpers";

interface Props {
	issueId?: string;
	issueNumber?: number;
	projectSlug?: string;
	workspaceSlug?: string;
}

function useResolvedIssueId(
	issueIdProp: string | undefined,
	issueNumber: number | undefined,
	projectSlug: string | undefined,
	workspaceSlug: string | undefined
) {
	const [issueId, setIssueId] = useState(issueIdProp ?? "");
	const [resolveError, setResolveError] = useState<string | null>(null);

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
			.catch((e) => setResolveError(String(e)));
	}, [issueIdProp, projectSlug, issueNumber, workspaceSlug]);

	// When served as fallback for pretty-URL issue routes (/projects/KEY/issues/N/title),
	// extract KEY and N from the pathname and resolve to a UUID via the API.
	useEffect(() => {
		if (issueIdProp || projectSlug || issueNumber !== undefined) return;
		const m = window.location.pathname.match(/^\/projects\/([^/]+)\/issues\/(\d+)\//);
		if (!m) return;
		apiFetch<{ id: string }>(`/api/issues/${m[1]}-${m[2]}`, { workspaceSlug })
			.then((data) => setIssueId(data.id))
			.catch((e) => setResolveError(String(e)));
	}, [issueIdProp, projectSlug, issueNumber, workspaceSlug]);

	return { issueId, resolveError };
}

function useBackHref() {
	const [backHref, setBackHref] = useState<string | null>(null);

	useEffect(() => {
		try {
			const ref = document.referrer;
			if (!ref) return;
			const url = new URL(ref);
			if ((url.pathname.startsWith("/issues") || url.pathname.startsWith("/epics")) && url.search) {
				setBackHref(url.pathname + url.search);
			}
		} catch {
			// ignore — invalid referrer
		}
	}, []);

	return backHref;
}

function useIssueLinks(issueId: string, workspaceSlug: string | undefined) {
	const [links, setLinks] = useState<IssueLink[]>([]);
	const [fetchingLinks, setFetchingLinks] = useState(false);

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

	return { links, fetchingLinks, fetchLinks };
}

function useIssueAttachments(issueId: string, workspaceSlug: string | undefined) {
	const [attachments, setAttachments] = useState<Attachment[]>([]);

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

	return { attachments, fetchAttachments };
}

function useEpicRelations(issue: IssueData | null, workspaceSlug: string | undefined) {
	const [parentEpic, setParentEpic] = useState<IssueData | null>(null);
	const [childIssues, setChildIssues] = useState<IssueData[]>([]);

	useEffect(() => {
		if (!issue) return;

		// Silently update address bar to canonical pretty URL when arriving via UUID fallback
		if (issue.project_key) {
			const canonical = issueUrl(issue.project_key, issue.number, issue.title, issue.id);
			history.replaceState(null, "", canonical);
			document.title = `${formatIssueRef(issue.project_key, issue.number)} - ${issue.title}`;
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

	return { parentEpic, childIssues };
}

function useIssueCore(
	issueId: string,
	workspaceSlug: string | undefined,
	fetchLinks: () => Promise<void>,
	fetchAttachments: () => Promise<void>
) {
	const [issue, setIssue] = useState<IssueData | null>(null);
	const [comments, setComments] = useState<Comment[]>([]);
	const [statuses, setStatuses] = useState<TaskStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [members, setMembers] = useState<Member[]>([]);
	const [currentUserId, setCurrentUserId] = useState<string | null>(null);

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
					const data = await apiFetch<{ members: Member[] }>(`/api/workspaces/${workspaceSlug}`, {
						workspaceSlug,
					});
					if (Array.isArray(data?.members)) setMembers(data.members);
				} catch {
					// non-fatal — assignee field falls back to display-only
				}
			})(),
		]).finally(() => setLoading(false));
	}, [fetchIssue, fetchComments, fetchLinks, fetchAttachments, workspaceSlug]);

	return {
		issue,
		setIssue,
		comments,
		statuses,
		loading,
		error,
		members,
		currentUserId,
		fetchIssue,
		fetchComments,
	};
}

function useIssueMutations(args: {
	issue: IssueData | null;
	setIssue: (updater: (prev: IssueData | null) => IssueData | null) => void;
	issueId: string;
	workspaceSlug: string | undefined;
	statuses: TaskStatus[];
	members: Member[];
	fetchIssue: () => Promise<void>;
}) {
	const { issue, setIssue, issueId, workspaceSlug, statuses, members, fetchIssue } = args;
	const [updatingStatus, setUpdatingStatus] = useState(false);
	const [updatingPriority, setUpdatingPriority] = useState(false);
	const [updatingAssignee, setUpdatingAssignee] = useState(false);

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
			await apiFetch(`/api/issues/${issueId}`, {
				workspaceSlug,
				method: "PATCH",
				body: { statusId },
			});
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
			await apiFetch(`/api/issues/${issueId}`, {
				workspaceSlug,
				method: "PATCH",
				body: { priority },
			});
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
				? {
						...prev,
						assignee_id: assigneeId || null,
						assignee_name: member?.name ?? member?.email ?? null,
					}
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

	return {
		updatingStatus,
		updatingPriority,
		updatingAssignee,
		changeStatus,
		changePriority,
		changeAssignee,
	};
}

function IssueBreadcrumb({ issue, backHref }: { issue: IssueData; backHref: string | null }) {
	return (
		<nav class="text-sm text-text-muted mb-5">
			{issue.type_key === "epic" ? (
				<a href={backHref ?? "/epics"} class="text-text-muted no-underline">
					← Epics
				</a>
			) : (
				<a
					href={backHref ?? `/issues${issue.project_key ? `?project=${issue.project_key}` : ""}`}
					class="text-text-muted no-underline"
				>
					← Issues
				</a>
			)}
		</nav>
	);
}

function IssueDetailView(props: {
	issue: IssueData;
	issueId: string;
	workspaceSlug?: string;
	backHref: string | null;
	issueRef: string;
	copyUrl: string;
	blockedByLinks: IssueLink[];
	parentEpic: IssueData | null;
	childIssues: IssueData[];
	links: IssueLink[];
	fetchingLinks: boolean;
	fetchLinks: () => Promise<void>;
	attachments: Attachment[];
	fetchAttachments: () => Promise<void>;
	comments: Comment[];
	currentUserId: string | null;
	fetchComments: () => Promise<void>;
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
	const { issue, issueId, workspaceSlug } = props;
	return (
		<article class="max-w-[900px] mx-auto">
			<IssueBreadcrumb issue={issue} backHref={props.backHref} />

			{/* Blocked-by banner */}
			{props.blockedByLinks.length > 0 && (
				<div
					role="alert"
					class="mb-4 px-[0.875rem] py-2 bg-[rgba(251,191,36,0.12)] border border-[rgba(251,191,36,0.5)]
						rounded-md text-sm text-text-base flex items-center gap-2"
				>
					<span>⚠</span>
					<span>
						Blocked by {props.blockedByLinks.length} issue
						{props.blockedByLinks.length > 1 ? "s" : ""}
					</span>
				</div>
			)}

			{/* Issue header */}
			<header class="mb-6">
				<div class="flex items-center gap-2 mb-3 flex-wrap">
					<RefChip issueRef={props.issueRef} copyUrl={props.copyUrl} />
					<ShareButton issueId={issueId} workspaceSlug={workspaceSlug} />
					{issue.type_name && (
						<span
							class="inline-flex items-center px-2 py-[0.125rem] rounded bg-surface border
								border-border text-xs font-medium text-text-muted"
						>
							{issue.type_name}
						</span>
					)}
					<ParentBadge parentEpic={props.parentEpic} />
				</div>

				<TitleSection
					issue={issue}
					issueId={issueId}
					workspaceSlug={workspaceSlug}
					fetchIssue={props.fetchIssue}
				/>
			</header>

			{/* Two-column body */}
			<div class="flex gap-8 items-start max-sm:flex-col">
				{/* ── Main column ── */}
				<div class="flex-1 min-w-0 max-sm:w-full">
					<BodySection
						issue={issue}
						issueId={issueId}
						workspaceSlug={workspaceSlug}
						fetchIssue={props.fetchIssue}
					/>

					<ChildIssuesSection issue={issue} childIssues={props.childIssues} />

					<RelationsSection
						issueId={issueId}
						workspaceSlug={workspaceSlug}
						links={props.links}
						fetchingLinks={props.fetchingLinks}
						fetchLinks={props.fetchLinks}
					/>

					<AttachmentsSection
						issueId={issueId}
						workspaceSlug={workspaceSlug}
						attachments={props.attachments}
						fetchAttachments={props.fetchAttachments}
					/>

					<CommentsSection
						issueId={issueId}
						workspaceSlug={workspaceSlug}
						comments={props.comments}
						currentUserId={props.currentUserId}
						fetchComments={props.fetchComments}
					/>
				</div>

				{/* ── Sidebar ── */}
				<SidebarPanel
					issue={issue}
					issueId={issueId}
					workspaceSlug={workspaceSlug}
					statuses={props.statuses}
					members={props.members}
					updatingStatus={props.updatingStatus}
					updatingPriority={props.updatingPriority}
					updatingAssignee={props.updatingAssignee}
					changeStatus={props.changeStatus}
					changePriority={props.changePriority}
					changeAssignee={props.changeAssignee}
					fetchIssue={props.fetchIssue}
				/>
			</div>
		</article>
	);
}

export default function IssueDetail({
	issueId: issueIdProp,
	issueNumber,
	projectSlug,
	workspaceSlug,
}: Props) {
	const { issueId, resolveError } = useResolvedIssueId(
		issueIdProp,
		issueNumber,
		projectSlug,
		workspaceSlug
	);
	const backHref = useBackHref();

	const { links, fetchingLinks, fetchLinks } = useIssueLinks(issueId, workspaceSlug);
	const { attachments, fetchAttachments } = useIssueAttachments(issueId, workspaceSlug);

	const {
		issue,
		setIssue,
		comments,
		statuses,
		loading,
		error,
		members,
		currentUserId,
		fetchIssue,
		fetchComments,
	} = useIssueCore(issueId, workspaceSlug, fetchLinks, fetchAttachments);

	const { parentEpic, childIssues } = useEpicRelations(issue, workspaceSlug);

	const {
		updatingStatus,
		updatingPriority,
		updatingAssignee,
		changeStatus,
		changePriority,
		changeAssignee,
	} = useIssueMutations({ issue, setIssue, issueId, workspaceSlug, statuses, members, fetchIssue });

	if (!issueId)
		return (
			<p class="text-text-muted">
				No issue ID provided. Add <code>?id=…</code> to the URL.
			</p>
		);
	if (loading) return <p aria-live="polite">Loading…</p>;
	const loadError = error ?? resolveError;
	if (loadError)
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load issue: {loadError}
			</p>
		);
	if (!issue) return null;

	const issueRef = formatIssueRef(issue.project_key, issue.number);
	const blockedByLinks = links.filter((l) => l.type === "blocked_by");
	const copyUrl = new URL(
		issueUrl(issue.project_key, issue.number, issue.title, issue.id),
		window.location.origin
	).href;

	return (
		<IssueDetailView
			issue={issue}
			issueId={issueId}
			workspaceSlug={workspaceSlug}
			backHref={backHref}
			issueRef={issueRef}
			copyUrl={copyUrl}
			blockedByLinks={blockedByLinks}
			parentEpic={parentEpic}
			childIssues={childIssues}
			links={links}
			fetchingLinks={fetchingLinks}
			fetchLinks={fetchLinks}
			attachments={attachments}
			fetchAttachments={fetchAttachments}
			comments={comments}
			currentUserId={currentUserId}
			fetchComments={fetchComments}
			statuses={statuses}
			members={members}
			updatingStatus={updatingStatus}
			updatingPriority={updatingPriority}
			updatingAssignee={updatingAssignee}
			changeStatus={changeStatus}
			changePriority={changePriority}
			changeAssignee={changeAssignee}
			fetchIssue={fetchIssue}
		/>
	);
}
