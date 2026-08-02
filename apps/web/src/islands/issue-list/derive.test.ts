import { describe, expect, it } from "vitest";
import type { Issue, TaskStatus } from "../board-utils";
import {
	deriveProjectDescription,
	deriveProjectOptions,
	deriveStatusOptions,
	deriveTypeOptions,
} from "./derive";
import type { ProjectMeta } from "./types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
	return {
		id: "project-1",
		key: "PROJ",
		name: "Project",
		description: "The main project",
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

// ─── deriveProjectDescription ──────────────────────────────────────────────

describe("deriveProjectDescription", () => {
	it("returns null when no project filter is active", () => {
		expect(deriveProjectDescription([makeProject()], "")).toBeNull();
	});

	it("returns the matching project's description", () => {
		expect(
			deriveProjectDescription([makeProject({ key: "PROJ", description: "desc" })], "PROJ")
		).toBe("desc");
	});

	it("returns null when no project matches the filter key", () => {
		expect(deriveProjectDescription([makeProject({ key: "OTHER" })], "PROJ")).toBeNull();
	});
});

// ─── deriveStatusOptions ────────────────────────────────────────────────────

describe("deriveStatusOptions", () => {
	it("prefers the statuses endpoint result when non-empty", () => {
		const statuses: TaskStatus[] = [
			{ id: "s1", key: "todo", name: "To Do", category: "todo", color: null },
		];
		expect(deriveStatusOptions([makeIssue()], statuses)).toBe(statuses);
	});

	it("derives unique statuses from issues when the endpoint returned none", () => {
		const issues = [
			makeIssue({ status_id: "s1", status_key: "todo", status_name: "To Do" }),
			makeIssue({ status_id: "s1", status_key: "todo", status_name: "To Do" }),
			makeIssue({
				status_id: "s2",
				status_key: "done",
				status_name: "Done",
				status_category: "done",
			}),
		];
		expect(deriveStatusOptions(issues, [])).toEqual([
			{ id: "s1", key: "todo", name: "To Do", category: "todo", color: null },
			{ id: "s2", key: "done", name: "Done", category: "done", color: null },
		]);
	});

	it("skips issues with no status_id", () => {
		const issues = [makeIssue({ status_id: null })];
		expect(deriveStatusOptions(issues, [])).toEqual([]);
	});
});

// ─── deriveProjectOptions ───────────────────────────────────────────────────

describe("deriveProjectOptions", () => {
	it("derives unique project options from issues", () => {
		const issues = [
			makeIssue({ project_key: "A", project_name: "Alpha" }),
			makeIssue({ project_key: "A", project_name: "Alpha" }),
			makeIssue({ project_key: "B", project_name: "Beta" }),
		];
		expect(deriveProjectOptions(issues)).toEqual([
			{ key: "A", name: "Alpha" },
			{ key: "B", name: "Beta" },
		]);
	});

	it("falls back to the key as the name when project_name is missing", () => {
		expect(deriveProjectOptions([makeIssue({ project_key: "A", project_name: null })])).toEqual([
			{ key: "A", name: "A" },
		]);
	});

	it("skips issues with no project_key", () => {
		expect(deriveProjectOptions([makeIssue({ project_key: null })])).toEqual([]);
	});
});

// ─── deriveTypeOptions ──────────────────────────────────────────────────────

describe("deriveTypeOptions", () => {
	it("derives unique type options as [key, name] entries", () => {
		const issues = [
			makeIssue({ type_key: "bug", type_name: "Bug" }),
			makeIssue({ type_key: "bug", type_name: "Bug" }),
			makeIssue({ type_key: "task", type_name: "Task" }),
		];
		expect(deriveTypeOptions(issues)).toEqual([
			["bug", "Bug"],
			["task", "Task"],
		]);
	});

	it("falls back to the key as the name when type_name is missing", () => {
		expect(deriveTypeOptions([makeIssue({ type_key: "bug", type_name: null })])).toEqual([
			["bug", "bug"],
		]);
	});

	it("skips issues with no type_key", () => {
		expect(deriveTypeOptions([makeIssue({ type_key: null })])).toEqual([]);
	});
});
