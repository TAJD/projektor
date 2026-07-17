import { useState } from "preact/hooks";
import { formatIssueRef } from "../../lib/issue-ref";
import { issueUrl } from "../../utils/issue-url";
import { getBacklogIssues, type Issue, type SortKey, type TaskStatus } from "../board-utils";
import {
	getStoryPoints,
	PrioritySelect,
	SortableHeader,
	StatusSelect,
	spBadge,
	statusBadge,
} from "./issue-render-helpers";

function applyBacklogOrder(issues: Issue[], backlogOrder: string[]): Issue[] {
	if (backlogOrder.length === 0) return issues;
	const inOrder = backlogOrder.flatMap((id) => {
		const issue = issues.find((i) => i.id === id);
		return issue ? [issue] : [];
	});
	const orderedIds = new Set(backlogOrder);
	const rest = issues.filter((i) => !orderedIds.has(i.id));
	return [...inOrder, ...rest];
}

function BacklogTableHead({
	sortBy,
	sortDir,
	onSort,
}: {
	sortBy: SortKey;
	sortDir: "asc" | "desc";
	onSort: (key: SortKey) => void;
}) {
	return (
		<thead>
			<tr class="bg-surface">
				<th class="w-8 px-2 py-2 border-b-2 border-border" />
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
	);
}

interface RowProps {
	issue: Issue;
	statuses: TaskStatus[];
	updatingId: string | null;
	updatingPriorityId: string | null;
	changeStatus: (issueId: string, statusId: string) => void;
	changePriority: (issueId: string, priority: string) => void;
	isDragging: boolean;
	isOver: boolean;
	onDragStart: (e: DragEvent, issueId: string) => void;
	onDragOver: (e: DragEvent, issueId: string) => void;
	onDrop: (e: DragEvent, issueId: string) => void;
	onDragEnd: () => void;
}

function BacklogRow({
	issue,
	statuses,
	updatingId,
	updatingPriorityId,
	changeStatus,
	changePriority,
	isDragging,
	isOver,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
}: RowProps) {
	const pts = getStoryPoints(issue);
	return (
		<tr
			key={issue.id}
			class="border-b border-border group"
			draggable={true}
			onDragStart={(e: DragEvent) => onDragStart(e, issue.id)}
			onDragOver={(e: DragEvent) => onDragOver(e, issue.id)}
			onDrop={(e: DragEvent) => onDrop(e, issue.id)}
			onDragEnd={onDragEnd}
			style={{
				opacity: isDragging ? 0.5 : 1,
				boxShadow: isOver ? "inset 0 2px 0 0 var(--accent)" : undefined,
			}}
		>
			<td class="px-2 py-2 align-middle w-8">
				<span
					class="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity select-none text-base leading-none"
					style={{ cursor: isDragging ? "grabbing" : "grab" }}
					aria-hidden="true"
				>
					⠿
				</span>
			</td>
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
}

function BacklogMobileCards({
	issues,
	updatingPriorityId,
	changePriority,
}: {
	issues: Issue[];
	updatingPriorityId: string | null;
	changePriority: (issueId: string, priority: string) => void;
}) {
	return (
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

interface BacklogViewProps {
	issues: Issue[];
	statuses: TaskStatus[];
	updatingId: string | null;
	updatingPriorityId: string | null;
	changeStatus: (issueId: string, statusId: string) => void;
	changePriority: (issueId: string, priority: string) => void;
	sortBy: SortKey;
	sortDir: "asc" | "desc";
	onSort: (key: SortKey) => void;
}

export default function BacklogView({
	issues,
	statuses,
	updatingId,
	updatingPriorityId,
	changeStatus,
	changePriority,
	sortBy,
	sortDir,
	onSort,
}: BacklogViewProps) {
	const [backlogOrder, setBacklogOrder] = useState<string[]>([]);
	const [backlogDragId, setBacklogDragId] = useState<string | null>(null);
	const [backlogDragOverId, setBacklogDragOverId] = useState<string | null>(null);

	const backlogIssues = getBacklogIssues(issues);
	if (backlogIssues.length === 0) {
		return <p class="text-text-base">No backlog issues match the current filters.</p>;
	}
	const orderedIssues = applyBacklogOrder(backlogIssues, backlogOrder);

	function onBacklogDragStart(e: DragEvent, issueId: string) {
		e.dataTransfer?.setData("text/plain", issueId);
		setBacklogDragId(issueId);
	}

	function onBacklogDragOver(e: DragEvent, issueId: string) {
		e.preventDefault();
		setBacklogDragOverId(issueId);
	}

	function onBacklogDrop(e: DragEvent, targetId: string) {
		e.preventDefault();
		const draggedId = e.dataTransfer?.getData("text/plain");
		if (!draggedId || draggedId === targetId) {
			setBacklogDragId(null);
			setBacklogDragOverId(null);
			return;
		}
		const ids = orderedIssues.map((i) => i.id);
		const without = ids.filter((id) => id !== draggedId);
		const targetIdx = without.indexOf(targetId);
		without.splice(targetIdx, 0, draggedId);
		setBacklogOrder(without);
		setBacklogDragId(null);
		setBacklogDragOverId(null);
	}

	function onBacklogDragEnd() {
		setBacklogDragId(null);
		setBacklogDragOverId(null);
	}

	return (
		<>
			<div class="overflow-x-auto max-sm:hidden">
				<table class="w-full border-collapse text-[0.9rem]">
					<BacklogTableHead sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
					<tbody
						onDragLeave={(e: DragEvent) => {
							if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
								setBacklogDragOverId(null);
							}
						}}
					>
						{orderedIssues.map((issue) => (
							<BacklogRow
								key={issue.id}
								issue={issue}
								statuses={statuses}
								updatingId={updatingId}
								updatingPriorityId={updatingPriorityId}
								changeStatus={changeStatus}
								changePriority={changePriority}
								isDragging={backlogDragId === issue.id}
								isOver={backlogDragOverId === issue.id && backlogDragId !== issue.id}
								onDragStart={onBacklogDragStart}
								onDragOver={onBacklogDragOver}
								onDrop={onBacklogDrop}
								onDragEnd={onBacklogDragEnd}
							/>
						))}
					</tbody>
				</table>
			</div>

			<BacklogMobileCards
				issues={orderedIssues}
				updatingPriorityId={updatingPriorityId}
				changePriority={changePriority}
			/>
		</>
	);
}
