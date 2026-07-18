import { useState } from "preact/hooks";
import { issueUrl } from "../../utils/issue-url";
import {
	assigneeInitials,
	BOARD_COLUMNS,
	categoryColor,
	getBoardColumnIssues,
	getFirstStatusForCategory,
	type Issue,
	type TaskStatus,
} from "../board-utils";
import { getStoryPoints, priorityBadge, StatusSelect, spBadge } from "./issue-render-helpers";

function BoardCard({
	issue,
	statuses,
	dragIssueId,
	setDragIssueId,
	changeStatus,
}: {
	issue: Issue;
	statuses: TaskStatus[];
	dragIssueId: string | null;
	setDragIssueId: (id: string | null) => void;
	changeStatus: (issueId: string, statusId: string) => void;
}) {
	const pts = getStoryPoints(issue);
	return (
		<div
			key={issue.id}
			class={[
				"bg-surface border border-border rounded-md px-3 py-2.5 shadow-sm select-none",
				"transition-all duration-150 hover:shadow-md hover:border-accent hover:-translate-y-px",
			].join(" ")}
			style={{ opacity: dragIssueId === issue.id ? 0.4 : 1 }}
		>
			<a
				href={issueUrl(issue.project_key, issue.number, issue.title, issue.id)}
				class="block no-underline"
				draggable={true}
				onDragStart={(e: DragEvent) => {
					if (window.innerWidth < 640) {
						e.preventDefault();
						return;
					}
					e.dataTransfer?.setData("text/plain", issue.id);
					setDragIssueId(issue.id);
				}}
				onDragEnd={() => setDragIssueId(null)}
			>
				<div class="font-mono text-[0.72rem] text-text-muted mb-1">
					{issue.project_key ? `${issue.project_key}-${issue.number}` : `#${issue.number}`}
				</div>
				<div class="text-sm font-medium text-text-base leading-[1.35] mb-2">{issue.title}</div>
				<div class="flex justify-between items-center gap-2">
					<div class="flex items-center gap-1.5">
						{priorityBadge(issue)}
						{pts && spBadge(pts)}
					</div>
					{issue.assignee_name && (
						<span
							title={issue.assignee_name}
							class={[
								"w-6 h-6 rounded-full bg-accent text-white text-[0.68rem] font-bold flex items-center",
								"justify-center shrink-0 uppercase",
							].join(" ")}
						>
							{assigneeInitials(issue.assignee_name)}
						</span>
					)}
				</div>
			</a>
			{/* Mobile-only: native HTML5 drag-and-drop (used above 640px) doesn't
			    work on touch devices, so narrow viewports get a tap-to-open status
			    menu instead (PROJ-416). Rendered as a sibling of the <a>, not
			    nested inside it, so the interactive Select never lands inside
			    anchor content (matching the ListSection desktop-table/mobile-card
			    convention, and avoiding an invalid interactive-in-anchor nesting). */}
			<div class="hidden max-sm:block mt-2">
				<StatusSelect
					issue={issue}
					statuses={statuses}
					busy={false}
					onChange={(statusId) => changeStatus(issue.id, statusId)}
				/>
			</div>
		</div>
	);
}

export default function BoardView({
	issues,
	statuses,
	changeStatus,
}: {
	issues: Issue[];
	statuses: TaskStatus[];
	changeStatus: (issueId: string, statusId: string) => void;
}) {
	const [dragIssueId, setDragIssueId] = useState<string | null>(null);
	const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

	return (
		<div class="flex gap-4 overflow-x-auto items-start max-sm:flex-col">
			{BOARD_COLUMNS.map((col) => {
				const colIssues = getBoardColumnIssues(issues, col.category);
				const isOver = dragOverColumn === col.category;
				const dropStatusId = getFirstStatusForCategory(statuses, col.category)?.id;

				return (
					<section
						key={col.category}
						aria-label={`${col.label} column`}
						class="shrink-0 w-[270px] max-sm:w-full"
						onDragOver={(e: DragEvent) => {
							e.preventDefault();
							setDragOverColumn(col.category);
						}}
						onDragLeave={(e: DragEvent) => {
							if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
								setDragOverColumn(null);
							}
						}}
						onDrop={(e: DragEvent) => {
							e.preventDefault();
							const issueId = e.dataTransfer?.getData("text/plain");
							if (issueId && dropStatusId && window.innerWidth >= 640) {
								changeStatus(issueId, dropStatusId);
							}
							setDragOverColumn(null);
						}}
					>
						<div class="px-3 py-2 bg-surface rounded-t-md border border-b-0 border-border flex justify-between items-center">
							<span class="font-semibold text-sm" style={{ color: categoryColor(col.category) }}>
								{col.label}
							</span>
							<span
								class={[
									"text-[0.7rem] text-text-muted bg-bg rounded-full px-[0.45rem] py-[0.1rem]",
									"font-semibold border border-border",
								].join(" ")}
							>
								{colIssues.length}
							</span>
						</div>

						<div
							class={[
								"rounded-b-md min-h-24 max-h-[62vh] overflow-y-auto p-2 flex flex-col gap-2",
								"transition-[border-color,background] duration-100",
							].join(" ")}
							style={{
								border: `1px solid ${isOver ? "var(--accent)" : "var(--border)"}`,
								background: isOver ? "rgba(37,99,235,0.04)" : "var(--bg)",
							}}
						>
							{colIssues.length === 0 ? (
								<p class="text-[0.8rem] text-text-muted text-center py-4 m-0">No issues</p>
							) : (
								colIssues.map((issue) => (
									<BoardCard
										key={issue.id}
										issue={issue}
										statuses={statuses}
										dragIssueId={dragIssueId}
										setDragIssueId={setDragIssueId}
										changeStatus={changeStatus}
									/>
								))
							)}
						</div>
					</section>
				);
			})}
		</div>
	);
}
