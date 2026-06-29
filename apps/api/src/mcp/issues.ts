import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import {
	createIssue,
	deleteIssue,
	getIssue,
	getPrioritizedIssues,
	listIssues,
	searchIssues,
	updateIssue,
} from "../services/issues";

export const issuesTools: MCPTool[] = [
	{
		name: "list_issues",
		description:
			"List issues in the workspace, optionally filtered by status, priority, project, or assignee",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: { type: "string", description: "Filter by task status ID" },
				category: {
					type: "string",
					enum: ["todo", "in_progress", "done", "cancelled"],
					description: "Filter by status category",
				},
				priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
				assignee: { type: "string", description: "Filter by assignee user ID" },
				parentId: {
					type: "string",
					description: "Filter by parent issue ID (returns direct children only)",
				},
				typeId: { type: "string", description: "Filter by task type ID" },
				excludeTypeIds: {
					type: "string",
					description: "Comma-separated task type IDs to exclude (e.g. the epic type)",
				},
				cursor: { type: "number", description: "Pagination cursor (created_at of last item)" },
				limit: { type: "number", default: 50, description: "Max 100" },
			},
		},
		handler(input, ctx) {
			return listIssues(ctx, input);
		},
	},
	{
		name: "get_issue",
		description: 'Get a single issue by ID or project key + number (e.g. "PROJ-42")',
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				ref: { type: "string", description: "Project key and number, e.g. PROJ-42" },
			},
		},
		handler(input, ctx) {
			return getIssue(ctx, input);
		},
	},
	{
		name: "create_issue",
		description: "Create a new issue in a project",
		inputSchema: {
			type: "object",
			required: ["projectId", "title"],
			properties: {
				projectId: { type: "string" },
				title: { type: "string" },
				body: { type: "string" },
				priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: { type: "string", description: "UUID of the task status to assign" },
				assigneeId: { type: "string", description: "UUID of the user to assign" },
				labels: { type: "array", items: { type: "string" } },
				parentId: {
					type: "string",
					description: "UUID of the parent issue (optional; max depth 5)",
				},
				typeId: { type: "string", description: "UUID of the task type to assign" },
			},
		},
		handler(input, ctx) {
			return createIssue(ctx, input);
		},
	},
	{
		name: "update_issue",
		description: "Update an issue — status, priority, title, body, assignee, or labels",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				title: { type: "string" },
				body: { type: "string" },
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: {
					type: "string",
					nullable: true,
					description: "UUID of the task status (null to clear)",
				},
				priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
				assigneeId: { type: "string", nullable: true },
				labels: { type: "array", items: { type: "string" } },
				parentId: {
					type: "string",
					nullable: true,
					description: "Set or clear the parent issue (null to remove)",
				},
				typeId: { type: "string", nullable: true },
			},
		},
		handler(input, ctx) {
			const { id, ...fields } = input as { id?: string; [k: string]: unknown };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return updateIssue(ctx, id, fields);
		},
	},
	{
		name: "search_issues",
		description: "Search issues by keyword in title or body",
		inputSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: { type: "string", minLength: 1 },
				projectId: { type: "string", description: "Restrict search to a specific project" },
				limit: { type: "number", default: 20, description: "Max 50" },
			},
		},
		handler(input, ctx) {
			return searchIssues(ctx, input);
		},
	},
	{
		name: "delete_issue",
		description: "Delete an issue by ID",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return deleteIssue(ctx, id);
		},
	},
	{
		name: "get_prioritized_issues",
		description:
			"Return open issues ranked by a composite score: link-network centrality (in-degree) + priority + inverse story points. Useful for deciding what to work on next.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					default: 10,
					description: "Max issues to return (default 10, max 100)",
				},
				includeBacklog: {
					type: "boolean",
					default: true,
					description: "Include backlog-status issues (default true)",
				},
			},
		},
		handler(input, ctx) {
			return getPrioritizedIssues(ctx, input);
		},
	},
];
