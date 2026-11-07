import { capPage, toPage } from "../mcp/serialize";
import { ListProjectActivitySchema } from "../schemas/project-activity";
import { listProjectActivity } from "../services/project-activity";
import { defineOperation } from "./define";

export const projectActivityOperations = [
	defineOperation({
		id: "list_project_activity",
		method: "GET",
		path: "/api/projects/:projectId/activity",
		domain: "project-activity",
		tier: "read",
		keywords: ["history", "events", "recent changes", "audit", "feed"],
		summary:
			"List recent activity events for a project across issues, comments, wiki pages, and sprints. " +
			"Returns `{items}` ordered most-recent first; a result over ~20,000 chars is cut to fit with " +
			"`truncated:true` (lower `limit` or raise `since`). See /projektor/agents/response-conventions/.",
		input: ListProjectActivitySchema,
		run: (ctx, input) => listProjectActivity(ctx, input),
		mcpResult: (result) => capPage(toPage(result as Parameters<typeof toPage>[0])),
	}),
];
