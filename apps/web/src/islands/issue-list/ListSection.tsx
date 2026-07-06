import { useEffect, useRef } from "preact/hooks";
import { formatIssueRef } from "../../lib/issue-ref";
import { issueUrl } from "../../utils/issue-url";
import type { Issue, SortKey, TaskStatus } from "../board-utils";
import {
	getStoryPoints,
	PrioritySelect,
	SortableHeader,
	StatusSelect,
	spBadge,
	statusBadge,
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

interface RowsProps {
	issues: Issue[];
	statuses: TaskStatus[];
	updatingId: string | null;
	updatingPriorityId: string | null;
	changeStatus: (issueId: string, statusId: string) => void;
	changePriority: (issueId: string, priority: string) => void;
}

function DesktopTable({
	issues,
	statuses,
	updatingId,
	updatingPriorityId,
	changeStatus,
	changePriority,
	sortBy,
	sortDir,
	onSort,
}: RowsProps & { sortBy: SortKey; sortDir: "asc" | "desc"; onSort: (key: SortKey) => void }) {
	return (
		<div class="overflow-x-auto max-sm:hidden">
			<table class="w-full border-collapse text-[0.9rem]">
				<thead>
					<tr class="bg-surface">
						<SortableHeader
							label="#"
							sortKey="number"
							sortBy={sortBy}
							sortDir={sortDir}
							onSort={onSort}
						/>
						<SortableHeader
							label="Title"
							sortKey="title"
							sortBy={sortBy}
							sortDir={sortDir}
							onSort={onSort}
							extraClass="w-full"
						/>
						<SortableHeader
							label="Priority"
							sortKey="priority"
							sortBy={sortBy}
							sortDir={sortDir}
							onSort={onSort}
						/>
						<SortableHeader
							label="Assignee"
							sortKey="assignee"
							sortBy={sortBy}
							sortDir={sortDir}
							onSort={onSort}
						/>
						<SortableHeader
							label="Status"
							sortKey="status"
							sortBy={sortBy}
							sortDir={sortDir}
							onSort={onSort}
						/>
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
	);
}

function MobileCards({ issues, updatingPriorityId, changePriority }: RowsProps) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{issues.map((issue) => (
				<div key={issue.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<div class="font-mono text-[0.8rem] text-text-muted mb-1">
						{formatIssueRef(issue.project_key, issue.number)}
					</div>
					<a
						href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
						class="no-underline"
					>
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
	);
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
	// Auto-paginate on scroll (PROJ-303): load the next page as soon as the sentinel
	// at the bottom of the list scrolls into view, instead of requiring a manual click.
	const sentinelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (nextCursor == null) return;
		const node = sentinelRef.current;
		if (!node) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) loadMore();
			},
			{ rootMargin: "400px" }
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [nextCursor, loadMore]);

	if (issues.length === 0) {
		return <p class="text-text-base">No issues match the current filters.</p>;
	}

	return (
		<>
			<DesktopTable
				issues={issues}
				statuses={statuses}
				updatingId={updatingId}
				updatingPriorityId={updatingPriorityId}
				changeStatus={changeStatus}
				changePriority={changePriority}
				sortBy={sortBy}
				sortDir={sortDir}
				onSort={onSort}
			/>

			<MobileCards
				issues={issues}
				statuses={statuses}
				updatingId={updatingId}
				updatingPriorityId={updatingPriorityId}
				changeStatus={changeStatus}
				changePriority={changePriority}
			/>

			{/* Auto-load sentinel (PROJ-201/303): fetches the next page once it scrolls
			    into view; only rendered while the server has another page. */}
			{nextCursor != null && (
				<div ref={sentinelRef} class="flex justify-center mt-4 py-2">
					{loadingMore && <span class="text-sm text-text-muted">Loading more…</span>}
				</div>
			)}
		</>
	);
}
