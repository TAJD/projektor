import type { MCPTool } from "@projektor/types";
import { listProjectActivity } from "../services/project-activity";
import { READ } from "./annotations";
import { toPage } from "./serialize";

export const projectActivityTools: MCPTool[] = [
	{
		name: "list_project_activity",
		description:
			"List recent activity events for a project across issues, comments, wiki pages, and sprints. " +
			"Returns `{items}` ordered most-recent first; a result over ~20,000 chars is cut to fit with " +
			"`truncated:true` (lower `limit` or raise `since`). See /projektor/agents/response-conventions/.",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: {
				projectId: { type: "string", description: "The project UUID to fetch activity for" },
				since: {
					type: "number",
					description: "Unix timestamp - only return events created at or after this time",
				},
				limit: {
					type: "number",
					default: 50,
					description: "Maximum number of events to return (default 50, max 200)",
				},
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			return toPage(await listProjectActivity(ctx, input));
		},
	},
];
