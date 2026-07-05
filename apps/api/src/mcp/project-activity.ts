import type { MCPTool } from "@projektor/types";
import { listProjectActivity } from "../services/project-activity";
import type { ServiceCtx } from "../services/types";

export const projectActivityTools: MCPTool[] = [
	{
		name: "list_project_activity",
		description:
			"List recent activity events for a project across issues, comments, wiki pages, and sprints. " +
			"Returns events ordered most-recent first.",
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
		async handler(input, ctx) {
			return listProjectActivity(ctx as unknown as ServiceCtx, input);
		},
	},
];
