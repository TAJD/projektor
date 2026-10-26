import { useEffect, useState } from "preact/hooks";
import { formatIssueRef } from "../lib/issue-ref";
import { statusDisplayName } from "../lib/status";
import { apiFetch } from "../utils/api-client";
import { issueUrl } from "../utils/issue-url";
import { categoryColor, type Issue } from "./board-utils";

interface Props {
	workspaceSlug?: string;
}

const OPEN_CATEGORIES = new Set(["todo", "in_progress", "in_review"]);

function getStoryPoints(issue: Issue): string | null {
	const field = (issue.customFields ?? []).find((f) => f.key === "story_points");
	return field?.value ?? null;
}

function spBadge(pts: string) {
	return (
		<span
			class="text-[0.68rem] text-text-muted bg-surface border border-border rounded-[3px]
				px-[0.3rem] font-semibold whitespace-nowrap leading-[1.6]"
		>
			{pts} SP
		</span>
	);
}

function priorityBadge(issue: Issue) {
	return (
		<span
			class="inline-flex items-center px-1.5 py-0.5 rounded text-[0.7rem] font-semibold capitalize whitespace-nowrap"
			style={{
				background: `var(--priority-${issue.priority}-bg, var(--priority-low-bg))`,
				color: `var(--priority-${issue.priority}-text, var(--text-muted))`,
			}}
		>
			{issue.priority === "none" ? "–" : issue.priority}
		</span>
	);
}

function isVisible(issue: Issue, includeDone: boolean): boolean {
	return includeDone ? true : OPEN_CATEGORIES.has(issue.status_category ?? "");
}

function statusBadge(issue: Issue) {
	return (
		<span class="font-medium text-sm" style={{ color: categoryColor(issue.status_category) }}>
			{statusDisplayName(issue.status_name, issue.status_key)}
		</span>
	);
}

interface ProjectGroup {
	name: string;
	issues: Issue[];
}

function groupIssuesByProject(visible: readonly Issue[]): {
	order: string[];
	byProject: Map<string, ProjectGroup>;
} {
	const order: string[] = [];
	const byProject = new Map<string, ProjectGroup>();
	for (const issue of visible) {
		const key = issue.project_key ?? "__none__";
		const name = issue.project_name ?? issue.project_key ?? "No project";
		let group = byProject.get(key);
		if (!group) {
			group = { name, issues: [] };
			byProject.set(key, group);
			order.push(key);
		}
		group.issues.push(issue);
	}
	return { order, byProject };
}

function ProjectIssuesSection({ name, issues }: { name: string; issues: Issue[] }) {
	return (
		<section>
			<h2 class="text-sm font-semibold text-text-muted uppercase tracking-[0.05em] mb-2 pb-1 border-b border-border">
				{name}
			</h2>

			{/* Desktop table */}
			<div class="overflow-x-auto max-sm:hidden">
				<table class="w-full border-collapse text-[0.9rem]">
					<thead>
						<tr class="bg-surface">
							<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
								#
							</th>
							<th class="text-left px-3 py-2 border-b-2 border-border font-semibold w-full text-text-base">
								Title
							</th>
							<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
								Priority
							</th>
							<th class="text-left px-3 py-2 border-b-2 border-border font-semibold whitespace-nowrap text-text-base">
								Status
							</th>
						</tr>
					</thead>
					<tbody>
						{issues.map((issue) => {
							const pts = getStoryPoints(issue);
							return (
								<tr key={issue.id} class="border-b border-border">
									<td class="px-3 py-2 align-middle whitespace-nowrap">
										<a
											href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
											class="text-text-muted font-mono text-[0.8rem] no-underline hover:underline focus:underline"
										>
											{formatIssueRef(issue.project_key, issue.number)}
										</a>
									</td>
									<td class="px-3 py-2 align-middle text-text-base">
										<a
											href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
											class="text-text-base no-underline hover:underline focus:underline"
										>
											{issue.title}
										</a>
									</td>
									<td class="px-3 py-2 align-middle whitespace-nowrap">
										<div class="flex items-center gap-[0.375rem]">
											{priorityBadge(issue)}
											{pts && spBadge(pts)}
										</div>
									</td>
									<td class="px-3 py-2 align-middle whitespace-nowrap">{statusBadge(issue)}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{/* Mobile cards */}
			<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
				{issues.map((issue) => (
					<div key={issue.id} class="py-3 px-4 border border-border rounded-md bg-surface">
						<a
							href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
							class="inline-block font-mono text-[0.8rem] text-text-muted no-underline hover:underline focus:underline mb-1"
						>
							{formatIssueRef(issue.project_key, issue.number)}
						</a>
						<a
							href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
							class="no-underline"
						>
							<div class="text-[0.9rem] text-text-base font-medium mb-2">{issue.title}</div>
						</a>
						<div class="flex gap-[0.375rem] flex-wrap items-center">
							{priorityBadge(issue)}
							{statusBadge(issue)}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

// The API caps a page at 100 rows. Issue #417: a single un-paged request silently dropped
// every assigned issue beyond the newest page, so we follow nextCursor until it is exhausted.
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

interface IssuePage {
	items: Issue[];
	nextCursor?: string | number | null;
}

async function fetchAllAssigned(
	includeDone: boolean,
	workspaceSlug: string | undefined
): Promise<Issue[]> {
	const all: Issue[] = [];
	let cursor: string | number | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		// PROJ-444: "me" resolves server-side to the calling user — no more
		// /auth/me round trip before this fetch can even start.
		const qs = new URLSearchParams({ assignee: "me", limit: String(PAGE_SIZE) });
		// Filter on the server so done/cancelled rows don't spend page slots when hidden.
		if (!includeDone) qs.set("open", "true");
		if (cursor != null) qs.set("cursor", String(cursor));
		const data: IssuePage = await apiFetch<IssuePage>(`/api/issues?${qs.toString()}`, {
			workspaceSlug,
		});
		if (Array.isArray(data.items)) all.push(...data.items);
		cursor = data.nextCursor ?? null;
		if (cursor == null) break;
	}
	return all;
}

export default function MyIssues({ workspaceSlug }: Props) {
	const [issues, setIssues] = useState<Issue[]>([]);
	const [loading, setLoading] = useState(true);
	const [hasLoaded, setHasLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [includeDone, setIncludeDone] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoading(true);
			setError(null);
			try {
				const items = await fetchAllAssigned(includeDone, workspaceSlug);
				if (cancelled) return;
				setIssues(items);
				setHasLoaded(true);
			} catch (e) {
				if (cancelled) return;
				setError(String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceSlug, includeDone]);

	// Only the first load replaces the page; toggling "Include done" refetches in place so
	// the checkbox stays put.
	if (loading && !hasLoaded) return <p aria-live="polite">Loading…</p>;
	if (error)
		return (
			<p role="alert" class="text-danger-text">
				Failed to load issues: {error}
			</p>
		);

	const visible = issues.filter((i) => isVisible(i, includeDone));
	const { order: projectOrder, byProject } = groupIssuesByProject(visible);
	const hasAny = visible.length > 0;

	return (
		<div>
			<div class="flex items-center gap-3 mb-5">
				<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer select-none">
					<input
						type="checkbox"
						checked={includeDone}
						onChange={(e) => setIncludeDone((e.target as HTMLInputElement).checked)}
						class="accent-accent w-4 h-4"
					/>
					Include done
				</label>
				<span class="text-sm text-text-muted">
					{visible.length} issue{visible.length !== 1 ? "s" : ""}
				</span>
			</div>

			{!hasAny ? (
				<div class="text-center py-16 text-text-muted">
					<p class="text-lg font-medium mb-1">No issues assigned to you</p>
					<p class="text-sm">
						{includeDone
							? "You have no issues across any project."
							: 'You have no open issues. Toggle "Include done" to see completed ones.'}
					</p>
				</div>
			) : (
				<div class="flex flex-col gap-8">
					{projectOrder.map((key) => {
						const group = byProject.get(key);
						if (!group) return null;
						return <ProjectIssuesSection key={key} name={group.name} issues={group.issues} />;
					})}
				</div>
			)}
		</div>
	);
}
