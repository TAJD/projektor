import { describe, expect, it } from "vitest";
import { filterIssues, type Issue, sortIssues } from "./board-utils";

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
		type_key: "bug",
		type_name: "Bug",
		status_id: "st-todo",
		status_key: "todo",
		status_name: "Todo",
		status_category: "todo",
		sprint_id: null,
		updated_at: 1000,
		created_at: 1000,
		...overrides,
	};
}

// ─── filterIssues ─────────────────────────────────────────────────────────────

describe("filterIssues — status predicate", () => {
	const issues = [
		makeIssue({ id: "a", status_id: "st-todo" }),
		makeIssue({ id: "b", status_id: "st-done" }),
		makeIssue({ id: "c", status_id: null }),
	];

	it("passes all issues when filterStatuses is empty", () => {
		expect(filterIssues(issues, [], [], "", "").map((i) => i.id)).toEqual(["a", "b", "c"]);
	});

	it("passes only issues whose status_id is in the filter", () => {
		expect(filterIssues(issues, ["st-todo"], [], "", "").map((i) => i.id)).toEqual(["a"]);
	});

	it("passes issues matching any of multiple status IDs", () => {
		expect(filterIssues(issues, ["st-todo", "st-done"], [], "", "").map((i) => i.id)).toEqual([
			"a",
			"b",
		]);
	});

	it("excludes issues with status_id=null even when filter is active", () => {
		const result = filterIssues(issues, ["st-todo"], [], "", "");
		expect(result.find((i) => i.id === "c")).toBeUndefined();
	});
});

describe("filterIssues — priority predicate", () => {
	const issues = [
		makeIssue({ id: "a", priority: "urgent" }),
		makeIssue({ id: "b", priority: "high" }),
		makeIssue({ id: "c", priority: "low" }),
	];

	it("passes all when filterPriorities is empty", () => {
		expect(filterIssues(issues, [], [], "", "").map((i) => i.id)).toEqual(["a", "b", "c"]);
	});

	it("passes only issues with matching priority", () => {
		expect(filterIssues(issues, [], ["high"], "", "").map((i) => i.id)).toEqual(["b"]);
	});

	it("passes issues matching any of multiple priorities", () => {
		expect(filterIssues(issues, [], ["urgent", "low"], "", "").map((i) => i.id)).toEqual([
			"a",
			"c",
		]);
	});
});

describe("filterIssues — project predicate", () => {
	const issues = [
		makeIssue({ id: "a", project_key: "ALPHA" }),
		makeIssue({ id: "b", project_key: "BETA" }),
		makeIssue({ id: "c", project_key: null }),
	];

	it("passes all when filterProject is empty string", () => {
		expect(filterIssues(issues, [], [], "", "").map((i) => i.id)).toEqual(["a", "b", "c"]);
	});

	it("passes only issues with matching project_key", () => {
		expect(filterIssues(issues, [], [], "ALPHA", "").map((i) => i.id)).toEqual(["a"]);
	});

	it("excludes issues with null project_key when filter is active", () => {
		expect(filterIssues(issues, [], [], "ALPHA", "").find((i) => i.id === "c")).toBeUndefined();
	});
});

describe("filterIssues — type predicate", () => {
	const issues = [
		makeIssue({ id: "a", type_key: "bug" }),
		makeIssue({ id: "b", type_key: "feat" }),
		makeIssue({ id: "c", type_key: null }),
	];

	it("passes all when filterType is empty string", () => {
		expect(filterIssues(issues, [], [], "", "").map((i) => i.id)).toEqual(["a", "b", "c"]);
	});

	it("passes only issues with matching type_key", () => {
		expect(filterIssues(issues, [], [], "", "feat").map((i) => i.id)).toEqual(["b"]);
	});
});

describe("filterIssues — combined predicates (AND semantics)", () => {
	const issues = [
		makeIssue({
			id: "a",
			status_id: "st-todo",
			priority: "high",
			project_key: "P1",
			type_key: "bug",
		}),
		makeIssue({
			id: "b",
			status_id: "st-done",
			priority: "high",
			project_key: "P1",
			type_key: "bug",
		}),
		makeIssue({
			id: "c",
			status_id: "st-todo",
			priority: "low",
			project_key: "P1",
			type_key: "bug",
		}),
		makeIssue({
			id: "d",
			status_id: "st-todo",
			priority: "high",
			project_key: "P2",
			type_key: "bug",
		}),
		makeIssue({
			id: "e",
			status_id: "st-todo",
			priority: "high",
			project_key: "P1",
			type_key: "feat",
		}),
	];

	it("narrows to only the issue matching all four predicates", () => {
		const result = filterIssues(issues, ["st-todo"], ["high"], "P1", "bug");
		expect(result.map((i) => i.id)).toEqual(["a"]);
	});

	it("returns empty when no issue satisfies all predicates", () => {
		expect(filterIssues(issues, ["st-done"], ["low"], "", "")).toHaveLength(0);
	});
});

describe("filterIssues — edge cases", () => {
	it("returns empty array for empty input", () => {
		expect(filterIssues([], ["st-todo"], ["high"], "P1", "bug")).toEqual([]);
	});

	it("returns empty array when all issues are filtered out", () => {
		const issues = [makeIssue({ status_id: "st-todo" })];
		expect(filterIssues(issues, ["st-done"], [], "", "")).toHaveLength(0);
	});
});

// ─── sortIssues ───────────────────────────────────────────────────────────────

describe("sortIssues — sort by number", () => {
	const issues = [
		makeIssue({ id: "a", number: 3 }),
		makeIssue({ id: "b", number: 1 }),
		makeIssue({ id: "c", number: 2 }),
	];

	it("sorts ascending by number", () => {
		expect(sortIssues(issues, "number", "asc").map((i) => i.number)).toEqual([1, 2, 3]);
	});

	it("sorts descending by number", () => {
		expect(sortIssues(issues, "number", "desc").map((i) => i.number)).toEqual([3, 2, 1]);
	});
});

describe("sortIssues — sort by priority", () => {
	const issues = [
		makeIssue({ id: "lo", priority: "low" }),
		makeIssue({ id: "ur", priority: "urgent" }),
		makeIssue({ id: "md", priority: "medium" }),
		makeIssue({ id: "hi", priority: "high" }),
	];

	it("sorts ascending: urgent → high → medium → low", () => {
		expect(sortIssues(issues, "priority", "asc").map((i) => i.id)).toEqual([
			"ur",
			"hi",
			"md",
			"lo",
		]);
	});

	it("sorts descending: low → medium → high → urgent", () => {
		expect(sortIssues(issues, "priority", "desc").map((i) => i.id)).toEqual([
			"lo",
			"md",
			"hi",
			"ur",
		]);
	});

	it("treats unknown priority as lowest (99) in ascending order", () => {
		const withUnknown = [
			makeIssue({ id: "u", priority: "whatever" }),
			makeIssue({ id: "h", priority: "high" }),
		];
		const result = sortIssues(withUnknown, "priority", "asc");
		expect(result[0].id).toBe("h");
		expect(result[1].id).toBe("u");
	});
});

describe("sortIssues — sort by updated_at", () => {
	const issues = [
		makeIssue({ id: "a", updated_at: 3000 }),
		makeIssue({ id: "b", updated_at: 1000 }),
		makeIssue({ id: "c", updated_at: 2000 }),
	];

	it("sorts ascending: oldest first", () => {
		expect(sortIssues(issues, "updated", "asc").map((i) => i.id)).toEqual(["b", "c", "a"]);
	});

	it("sorts descending: newest first", () => {
		expect(sortIssues(issues, "updated", "desc").map((i) => i.id)).toEqual(["a", "c", "b"]);
	});
});

describe("sortIssues — does not mutate the input array", () => {
	it("returns a new array reference", () => {
		const issues = [makeIssue({ id: "a", number: 2 }), makeIssue({ id: "b", number: 1 })];
		const original = [...issues];
		const result = sortIssues(issues, "number", "asc");
		expect(result).not.toBe(issues);
		expect(issues.map((i) => i.id)).toEqual(original.map((i) => i.id));
	});
});

describe("sortIssues — edge cases", () => {
	it("returns empty array for empty input", () => {
		expect(sortIssues([], "number", "asc")).toEqual([]);
	});

	it("returns single-element array unchanged", () => {
		const single = [makeIssue({ id: "only" })];
		expect(sortIssues(single, "number", "desc").map((i) => i.id)).toEqual(["only"]);
	});
});
