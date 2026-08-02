import { describe, expect, it } from "vitest";
import type { Issue } from "../board-utils";
import { getStoryPoints } from "./issue-render-helpers";

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

describe("getStoryPoints", () => {
	it("returns null when the issue has no custom fields", () => {
		expect(getStoryPoints(makeIssue())).toBeNull();
	});

	it("returns null when no custom field has the story_points key", () => {
		const issue = makeIssue({
			customFields: [{ key: "team", label: "Team", type: "text", value: "Core" }],
		});
		expect(getStoryPoints(issue)).toBeNull();
	});

	it("returns the story_points field value when present", () => {
		const issue = makeIssue({
			customFields: [{ key: "story_points", label: "Story Points", type: "number", value: "5" }],
		});
		expect(getStoryPoints(issue)).toBe("5");
	});
});
