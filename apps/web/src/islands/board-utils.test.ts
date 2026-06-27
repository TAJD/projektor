import { describe, expect, it } from "vitest";
import {
	assigneeInitials,
	BOARD_COLUMNS,
	CATEGORY_COLORS,
	categoryColor,
	getBacklogIssues,
	getBoardColumnIssues,
	getFirstStatusForCategory,
	type Issue,
	type TaskStatus,
} from "./board-utils";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeStatus(overrides: Partial<TaskStatus> = {}): TaskStatus {
	return {
		id: "status-1",
		key: "todo",
		name: "To Do",
		category: "todo",
		color: null,
		...overrides,
	};
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
	return {
		id: "issue-1",
		number: 1,
		title: "Test issue",
		priority: "medium",
		assignee_id: null,
		assignee_name: null,
		parent_id: null,
		project_key: "PROJ",
		project_name: "Project",
		type_key: null,
		type_name: null,
		status_id: "status-1",
		status_key: "todo",
		status_name: "To Do",
		status_category: "todo",
		sprint_id: null,
		updated_at: 1000,
		created_at: 1000,
		...overrides,
	};
}

// ─── assigneeInitials ─────────────────────────────────────────────────────────

describe("assigneeInitials", () => {
	it("returns first + last initials for a two-word name", () => {
		expect(assigneeInitials("John Doe")).toBe("JD");
	});

	it("returns first + last initials for a three-word name", () => {
		expect(assigneeInitials("Mary Jane Watson")).toBe("MW");
	});

	it("returns first two chars for a single-word name", () => {
		expect(assigneeInitials("Alice")).toBe("AL");
	});

	it("uppercases the result", () => {
		expect(assigneeInitials("jane doe")).toBe("JD");
	});

	it("handles extra whitespace between words", () => {
		expect(assigneeInitials("  John   Doe  ")).toBe("JD");
	});

	it("returns two chars for a two-char name", () => {
		expect(assigneeInitials("Jo")).toBe("JO");
	});
});

// ─── categoryColor ────────────────────────────────────────────────────────────

describe("categoryColor", () => {
	it("returns the mapped color for known categories", () => {
		expect(categoryColor("todo")).toBe(CATEGORY_COLORS.todo);
		expect(categoryColor("in_progress")).toBe(CATEGORY_COLORS.in_progress);
		expect(categoryColor("in_review")).toBe(CATEGORY_COLORS.in_review);
		expect(categoryColor("done")).toBe(CATEGORY_COLORS.done);
		expect(categoryColor("cancelled")).toBe(CATEGORY_COLORS.cancelled);
	});

	it("returns var(--text-muted) for an unknown category string", () => {
		expect(categoryColor("unknown")).toBe("var(--text-muted)");
	});

	it("returns var(--text-muted) for null", () => {
		expect(categoryColor(null)).toBe("var(--text-muted)");
	});
});

// ─── BOARD_COLUMNS ────────────────────────────────────────────────────────────

describe("BOARD_COLUMNS", () => {
	it("contains exactly four columns", () => {
		expect(BOARD_COLUMNS).toHaveLength(4);
	});

	it("covers the four active categories", () => {
		const cats = BOARD_COLUMNS.map((c) => c.category);
		expect(cats).toContain("todo");
		expect(cats).toContain("in_progress");
		expect(cats).toContain("in_review");
		expect(cats).toContain("done");
	});

	it("does not include cancelled or backlog columns", () => {
		const cats = BOARD_COLUMNS.map((c) => c.category);
		expect(cats).not.toContain("cancelled");
		expect(cats).not.toContain("backlog");
	});
});

// ─── getFirstStatusForCategory ───────────────────────────────────────────────

describe("getFirstStatusForCategory", () => {
	const statuses: TaskStatus[] = [
		makeStatus({ id: "s-backlog", key: "backlog", name: "Backlog", category: "todo" }),
		makeStatus({ id: "s-todo", key: "todo", name: "To Do", category: "todo" }),
		makeStatus({ id: "s-ip", key: "in_progress", name: "In Progress", category: "in_progress" }),
		makeStatus({ id: "s-done", key: "done", name: "Done", category: "done" }),
	];

	it("skips backlog and returns the first non-backlog todo status", () => {
		const result = getFirstStatusForCategory(statuses, "todo");
		expect(result?.id).toBe("s-todo");
	});

	it("falls back to backlog if it is the only todo status", () => {
		const onlyBacklog = [makeStatus({ id: "s-backlog", key: "backlog", category: "todo" })];
		const result = getFirstStatusForCategory(onlyBacklog, "todo");
		expect(result?.id).toBe("s-backlog");
	});

	it("returns the first status for non-todo categories", () => {
		expect(getFirstStatusForCategory(statuses, "in_progress")?.id).toBe("s-ip");
		expect(getFirstStatusForCategory(statuses, "done")?.id).toBe("s-done");
	});

	it("returns undefined for a category with no statuses", () => {
		expect(getFirstStatusForCategory(statuses, "in_review")).toBeUndefined();
	});

	it("returns undefined for an empty statuses array", () => {
		expect(getFirstStatusForCategory([], "todo")).toBeUndefined();
	});
});

// ─── getBoardColumnIssues ─────────────────────────────────────────────────────

describe("getBoardColumnIssues", () => {
	const issues: Issue[] = [
		makeIssue({ id: "i1", status_category: "todo", status_key: "backlog" }),
		makeIssue({ id: "i2", status_category: "todo", status_key: "todo" }),
		makeIssue({ id: "i3", status_category: "in_progress", status_key: "in_progress" }),
		makeIssue({ id: "i4", status_category: "in_review", status_key: "in_review" }),
		makeIssue({ id: "i5", status_category: "done", status_key: "done" }),
		makeIssue({ id: "i6", status_category: "cancelled", status_key: "cancelled" }),
	];

	it("returns non-backlog todo issues for the todo column", () => {
		const result = getBoardColumnIssues(issues, "todo");
		expect(result.map((i) => i.id)).toEqual(["i2"]);
	});

	it("excludes backlog issues from the todo column", () => {
		const result = getBoardColumnIssues(issues, "todo");
		expect(result.find((i) => i.status_key === "backlog")).toBeUndefined();
	});

	it("returns all in_progress issues", () => {
		expect(getBoardColumnIssues(issues, "in_progress").map((i) => i.id)).toEqual(["i3"]);
	});

	it("returns all in_review issues", () => {
		expect(getBoardColumnIssues(issues, "in_review").map((i) => i.id)).toEqual(["i4"]);
	});

	it("returns all done issues", () => {
		expect(getBoardColumnIssues(issues, "done").map((i) => i.id)).toEqual(["i5"]);
	});

	it("does NOT exclude backlog-keyed issues from non-todo columns", () => {
		// Odd data, but the function should only gate on (category=todo & key=backlog)
		const oddIssue = makeIssue({
			id: "odd",
			status_category: "in_progress",
			status_key: "backlog",
		});
		expect(getBoardColumnIssues([oddIssue], "in_progress").map((i) => i.id)).toEqual(["odd"]);
	});

	it("returns empty array when no issues match the column category", () => {
		// No issue in the fixture has category 'archived'
		expect(getBoardColumnIssues(issues, "archived")).toEqual([]);
	});

	it("returns empty array for an empty input", () => {
		expect(getBoardColumnIssues([], "todo")).toEqual([]);
	});
});

// ─── getBacklogIssues ─────────────────────────────────────────────────────────

describe("getBacklogIssues", () => {
	const issues: Issue[] = [
		makeIssue({ id: "i1", status_category: "todo", status_key: "backlog" }),
		makeIssue({ id: "i2", status_category: "todo", status_key: "todo" }),
		makeIssue({ id: "i3", status_category: "in_progress", status_key: "in_progress" }),
		makeIssue({ id: "i4", status_category: "done", status_key: "done" }),
	];

	it("returns only issues with category=todo and key=backlog", () => {
		expect(getBacklogIssues(issues).map((i) => i.id)).toEqual(["i1"]);
	});

	it("does not include todo issues with a different key", () => {
		const result = getBacklogIssues(issues);
		expect(result.find((i) => i.status_key === "todo")).toBeUndefined();
	});

	it("does not include non-todo issues even if their key is backlog", () => {
		const odd = makeIssue({ id: "odd", status_category: "in_progress", status_key: "backlog" });
		expect(getBacklogIssues([odd])).toEqual([]);
	});

	it("returns empty array when no backlog issues exist", () => {
		expect(getBacklogIssues([makeIssue({ status_key: "todo" })])).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(getBacklogIssues([])).toEqual([]);
	});
});
