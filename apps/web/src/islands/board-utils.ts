export interface TaskStatus {
	id: string;
	key: string;
	name: string;
	category: string;
	color: string | null;
}

export interface CustomFieldValue {
	key: string;
	label: string;
	type: string;
	value: string;
}

export interface Issue {
	id: string;
	number: number;
	title: string;
	priority: string;
	assignee_id: string | null;
	assignee_name: string | null;
	parent_id: string | null;
	project_id?: string | null;
	project_key: string | null;
	project_name: string | null;
	type_key: string | null;
	type_name: string | null;
	status_id: string | null;
	status_key: string | null;
	status_name: string | null;
	status_category: string | null;
	sprint_id: string | null;
	updated_at: number;
	created_at: number;
	customFields?: CustomFieldValue[];
}

export type SortKey =
	| "number"
	| "priority"
	| "updated"
	| "status"
	| "assignee"
	| "created_at"
	| "title";

export const PRIORITY_ORDER: Record<string, number> = {
	urgent: 0,
	high: 1,
	medium: 2,
	low: 3,
	none: 4,
};

const STATUS_CATEGORY_ORDER: Record<string, number> = {
	todo: 0,
	in_progress: 1,
	in_review: 2,
	done: 3,
	cancelled: 5,
};

export const CATEGORY_COLORS: Record<string, string> = {
	todo: "var(--status-todo)",
	in_progress: "var(--status-in-progress)",
	in_review: "var(--status-in-review)",
	done: "var(--status-done)",
	cancelled: "var(--status-cancelled)",
};

export const BOARD_COLUMNS: { category: string; label: string }[] = [
	{ category: "todo", label: "Todo" },
	{ category: "in_progress", label: "In Progress" },
	{ category: "in_review", label: "In Review" },
	{ category: "done", label: "Done" },
];

export function categoryColor(category: string | null): string {
	return category ? (CATEGORY_COLORS[category] ?? "var(--text-muted)") : "var(--text-muted)";
}

export function assigneeInitials(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

/**
 * Returns the best drop-target status ID for a given board column category.
 * For 'todo': prefers the first non-backlog status; falls back to any todo status.
 * For other categories: returns the first status in that category.
 */
export function getFirstStatusForCategory(
	statuses: TaskStatus[],
	category: string
): TaskStatus | undefined {
	if (category === "todo") {
		return (
			statuses.find((s) => s.category === "todo" && s.key !== "backlog") ??
			statuses.find((s) => s.category === "todo")
		);
	}
	return statuses.find((s) => s.category === category);
}

/**
 * Returns issues to display in a board column.
 * Todo column excludes backlog issues (those belong to the Backlog view).
 */
export function getBoardColumnIssues(issues: Issue[], category: string): Issue[] {
	return issues.filter(
		(i) => i.status_category === category && (category !== "todo" || i.status_key !== "backlog")
	);
}

/** Returns issues for the Backlog view: todo category with backlog key. */
export function getBacklogIssues(issues: Issue[]): Issue[] {
	return issues.filter((i) => i.status_category === "todo" && i.status_key === "backlog");
}

/** Applies multi-predicate filtering to an issue list (all predicates are AND-ed). */
export function filterIssues(
	issues: Issue[],
	filterStatuses: string[],
	filterPriorities: string[],
	filterProject: string,
	filterType: string
): Issue[] {
	return issues
		.filter(
			(i) =>
				filterStatuses.length === 0 ||
				(i.status_id !== null && filterStatuses.includes(i.status_id))
		)
		.filter((i) => filterPriorities.length === 0 || filterPriorities.includes(i.priority))
		.filter((i) => !filterProject || i.project_key === filterProject)
		.filter((i) => !filterType || i.type_key === filterType);
}

/** Sorts a copy of an issue list by the given SortKey. */
export function sortIssues(issues: Issue[], sortBy: SortKey, sortDir: "asc" | "desc"): Issue[] {
	return [...issues].sort((a, b) => {
		let diff = 0;
		if (sortBy === "number") {
			diff = a.number - b.number;
		} else if (sortBy === "priority") {
			diff = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
		} else if (sortBy === "updated") {
			diff = a.updated_at - b.updated_at;
		} else if (sortBy === "created_at") {
			diff = a.created_at - b.created_at;
		} else if (sortBy === "title") {
			diff = a.title.localeCompare(b.title);
		} else if (sortBy === "assignee") {
			diff = (a.assignee_name ?? "").localeCompare(b.assignee_name ?? "");
		} else if (sortBy === "status") {
			// backlog issues: status_category=todo, status_key=backlog → order slot 4
			const aOrder =
				a.status_key === "backlog" ? 4 : (STATUS_CATEGORY_ORDER[a.status_category ?? ""] ?? 99);
			const bOrder =
				b.status_key === "backlog" ? 4 : (STATUS_CATEGORY_ORDER[b.status_category ?? ""] ?? 99);
			diff = aOrder - bOrder;
		}
		return sortDir === "asc" ? diff : -diff;
	});
}
