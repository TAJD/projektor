import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { issueUrl } from "../../utils/issue-url";
import {
	assigneeInitials,
	BOARD_COLUMNS,
	categoryColor,
	getBacklogIssues,
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
				"bg-surface border border-border rounded-md px-3 py-2.5 shadow-xs select-none",
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
								"w-6 h-6 rounded-full bg-accent text-on-accent text-[0.68rem] font-bold flex items-center",
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

/**
 * Backlog issues deliberately have no board column (the Backlog view is where they are
 * triaged), but the count above the board still includes them — so without this note a
 * board of backlog-only issues reads as "6 issues" over four empty columns.
 */
function BacklogNote({ count, onShowBacklog }: { count: number; onShowBacklog?: () => void }) {
	if (count === 0) return null;
	const noun = `${count} issue${count === 1 ? "" : "s"}`;
	return (
		<p class="m-0 mb-3 text-sm text-text-muted" data-testid="board-backlog-note">
			{noun} in Backlog {count === 1 ? "isn't" : "aren't"} shown on the board.{" "}
			{onShowBacklog && (
				<button
					type="button"
					onClick={onShowBacklog}
					class="bg-transparent border-none p-0 text-accent underline cursor-pointer font-[inherit]"
				>
					View backlog
				</button>
			)}
		</p>
	);
}

export default function BoardView({
	issues,
	statuses,
	changeStatus,
	onShowBacklog,
}: {
	issues: Issue[];
	statuses: TaskStatus[];
	changeStatus: (issueId: string, statusId: string) => void;
	onShowBacklog?: () => void;
}) {
	const [dragIssueId, setDragIssueId] = useState<string | null>(null);
	const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
	const rowRef = useRef<HTMLDivElement>(null);
	const [rowHeight, setRowHeight] = useState<string | undefined>(undefined);

	useLayoutEffect(() => {
		const row = rowRef.current;
		if (!row) return;
		const fitToViewport = () => {
			if (window.innerWidth < 640) {
				setRowHeight(undefined);
				return;
			}
			const top = Math.round(row.getBoundingClientRect().top + window.scrollY);
			setRowHeight(`max(24rem, calc(100dvh - ${top}px - 2rem))`);
		};
		fitToViewport();
		const observer = new ResizeObserver(fitToViewport);
		observer.observe(document.body);
		window.addEventListener("resize", fitToViewport);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", fitToViewport);
		};
	}, []);

	return (
		<>
			<BacklogNote count={getBacklogIssues(issues).length} onShowBacklog={onShowBacklog} />
			<div
				ref={rowRef}
				class="flex gap-4 overflow-x-auto max-sm:flex-col"
				style={{ height: rowHeight }}
			>
				{BOARD_COLUMNS.map((col) => {
					const colIssues = getBoardColumnIssues(issues, col.category);
					const isOver = dragOverColumn === col.category;
					const dropStatusId = getFirstStatusForCategory(statuses, col.category)?.id;

					return (
						<section
							key={col.category}
							aria-label={`${col.label} column`}
							class="flex-1 min-w-[240px] min-h-0 flex flex-col max-sm:flex-none max-sm:w-full max-sm:min-w-0"
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
									"flex-1 rounded-b-md min-h-24 max-sm:max-h-[62vh] overflow-y-auto p-2 flex flex-col gap-2",
									"transition-[border-color,background] duration-100",
								].join(" ")}
								style={{
									border: `1px solid ${isOver ? "var(--accent)" : "var(--border)"}`,
									background: isOver ? "var(--dropzone-bg)" : "var(--bg)",
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
		</>
	);
}
