import { formatIssueRef } from "../../lib/issue-ref";
import { issueUrl } from "../../utils/issue-url";
import type { Issue, SortKey, TaskStatus } from "../board-utils";
import {
	getStoryPoints,
	PrioritySelect,
	SortableHeader,
	spBadge,
	statusBadge,
	StatusSelect,
} from "./issue-render-helpers";

interface ListSectionProps {
	issues: Issue[];
	statuses: TaskStatus[];
	updatingId: string | null;
	updatingPriorityId: string | null;
	changeStatus: (issueId: string, statusId: string) => void;
	changePriority: (issueId: string, priority: string) => void;
	sortBy: SortKey;
	sortDir: "asc" | "desc";
	onSort: (key: SortKey) => void;
	nextCursor: number | null;
	loadingMore: boolean;
	loadMore: () => void;
}

export default function ListSection({
	issues,
	statuses,
	updatingId,
	updatingPriorityId,
	changeStatus,
	changePriority,
	sortBy,
	sortDir,
	onSort,
	nextCursor,
	loadingMore,
	loadMore,
}: ListSectionProps) {
	if (issues.length === 0) {
		return <p class="text-text-base">No issues match the current filters.</p>;
	}

	return (
		<>
			<div class="overflow-x-auto max-sm:hidden">
				<table class="w-full border-collapse text-[0.9rem]">
					<thead>
						<tr class="bg-surface">
							<SortableHeader label="#" sortKey="number" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
							<SortableHeader
								label="Title"
								sortKey="title"
								sortBy={sortBy}
								sortDir={sortDir}
								onSort={onSort}
								extraClass="w-full"
							/>
							<SortableHeader label="Priority" sortKey="priority" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
							<SortableHeader label="Assignee" sortKey="assignee" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
							<SortableHeader label="Status" sortKey="status" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
						</tr>
					</thead>
					<tbody>
						{issues.map((issue) => {
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
											href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
											class="text-text-base no-underline hover:underline focus:underline"
										>
											{issue.title}
										</a>
									</td>
									<td class="px-3 py-2 align-middle whitespace-nowrap">
										<div class="flex items-center gap-[0.375rem]">
											<PrioritySelect
												issue={issue}
												busy={updatingPriorityId === issue.id}
												onChange={(v) => changePriority(issue.id, v)}
											/>
											{pts && spBadge(pts)}
										</div>
									</td>
									<td class="px-3 py-2 align-middle whitespace-nowrap text-text-base">
										{issue.assignee_name ?? <span class="text-text-muted">—</span>}
									</td>
									<td class="px-3 py-2 align-middle whitespace-nowrap">
										<StatusSelect
											issue={issue}
											statuses={statuses}
											busy={updatingId === issue.id}
											onChange={(v) => changeStatus(issue.id, v)}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
				{issues.map((issue) => (
					<div key={issue.id} class="py-3 px-4 border border-border rounded-md bg-surface">
						<div class="font-mono text-[0.8rem] text-text-muted mb-1">
							{formatIssueRef(issue.project_key, issue.number)}
						</div>
						<a href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)} class="no-underline">
							<div class="text-[0.9rem] text-text-base font-medium mb-2">{issue.title}</div>
						</a>
						<div class="flex gap-[0.375rem] flex-wrap">
							<PrioritySelect
								issue={issue}
								busy={updatingPriorityId === issue.id}
								onChange={(v) => changePriority(issue.id, v)}
							/>
							{statusBadge(issue)}
						</div>
					</div>
				))}
			</div>

			{/* Load more (PROJ-201): visible only while the server has another page */}
			{nextCursor != null && (
				<div class="flex justify-center mt-4">
					<button type="button" class="btn btn-outline" onClick={loadMore} disabled={loadingMore}>
						{loadingMore ? "Loading…" : "Load more"}
					</button>
				</div>
			)}
		</>
	);
}
