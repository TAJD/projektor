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
		<span class="text-[0.68rem] text-text-muted bg-surface border border-border rounded-[3px] px-[0.3rem] font-semibold whitespace-nowrap leading-[1.6]">
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

function statusBadge(issue: Issue) {
	return (
		<span class="font-medium text-sm" style={{ color: categoryColor(issue.status_category) }}>
			{statusDisplayName(issue.status_name, issue.status_key)}
		</span>
	);
}

export default function MyIssues({ workspaceSlug }: Props) {
	const [issues, setIssues] = useState<Issue[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [includeDone, setIncludeDone] = useState(false);

	useEffect(() => {
		(async () => {
			setLoading(true);
			setError(null);
			try {
				const meData = await apiFetch<{ user: { id: string } }>("/auth/me", { workspaceSlug });
				const userId = meData.user.id;

				const data = await apiFetch<{ items: Issue[] }>(
					`/api/issues?assignee=${encodeURIComponent(userId)}`,
					{ workspaceSlug }
				);
				setIssues(Array.isArray(data.items) ? data.items : []);
			} catch (e) {
				setError(String(e));
			} finally {
				setLoading(false);
			}
		})();
	}, [workspaceSlug]);

	if (loading) return <p aria-live="polite">Loading…</p>;
	if (error)
		return (
			<p role="alert" style={{ color: "var(--danger-text)" }}>
				Failed to load issues: {error}
			</p>
		);

	const visible = issues.filter((i) =>
		includeDone ? true : OPEN_CATEGORIES.has(i.status_category ?? "")
	);

	// Group by project
	const projectOrder: string[] = [];
	const byProject = new Map<string, { name: string; issues: Issue[] }>();
	for (const issue of visible) {
		const key = issue.project_key ?? "__none__";
		const name = issue.project_name ?? issue.project_key ?? "No project";
		let group = byProject.get(key);
		if (!group) {
			group = { name, issues: [] };
			byProject.set(key, group);
			projectOrder.push(key);
		}
		group.issues.push(issue);
	}

	const hasAny = visible.length > 0;

	return (
		<div>
			<div class="flex items-center gap-3 mb-5">
				<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer select-none">
					<input
						type="checkbox"
						checked={includeDone}
						onChange={(e) => setIncludeDone((e.target as HTMLInputElement).checked)}
						class="accent-[var(--accent)] w-4 h-4"
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
						return (
							<section key={key}>
								<h2 class="text-sm font-semibold text-text-muted uppercase tracking-[0.05em] mb-2 pb-1 border-b border-border">
									{group.name}
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
											{group.issues.map((issue) => {
												const pts = getStoryPoints(issue);
												return (
													<tr key={issue.id} class="border-b border-border">
														<td class="px-3 py-2 align-middle whitespace-nowrap">
															<span class="text-text-muted font-mono text-[0.8rem]">
																{formatIssueRef(issue.project_key, issue.number)}
															</span>
														</td>
														<td class="px-3 py-2 align-middle text-text-base">
															<a
																href={issueUrl(
																	issue.project_key,
																	issue.number,
																	issue.title,
																	issue.id
																)}
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
														<td class="px-3 py-2 align-middle whitespace-nowrap">
															{statusBadge(issue)}
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>

								{/* Mobile cards */}
								<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
									{group.issues.map((issue) => (
										<div
											key={issue.id}
											class="py-3 px-4 border border-border rounded-md bg-surface"
										>
											<div class="font-mono text-[0.8rem] text-text-muted mb-1">
												{formatIssueRef(issue.project_key, issue.number)}
											</div>
											<a
												href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
												class="no-underline"
											>
												<div class="text-[0.9rem] text-text-base font-medium mb-2">
													{issue.title}
												</div>
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
					})}
				</div>
			)}
		</div>
	);
}
