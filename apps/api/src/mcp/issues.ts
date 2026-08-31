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
			"List issues in the workspace, optionally filtered by status, priority, project, or assignee. " +
			"Items omit `body` by default — pass includeBody:true to include it. Pass includeRollups:true " +
			"to attach a `rollup` (child status counts: total/byStatus/done/remaining) to each item.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "UUID of the project, or a project key like PROJ",
				},
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: { type: "string", description: "Filter by task status ID" },
				statusIds: {
					type: "string",
					description: "Comma-separated task status IDs (OR-matched)",
				},
				category: {
					type: "string",
					enum: ["todo", "in_progress", "done", "cancelled"],
					description: "Filter by status category",
				},
				priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
				priorities: {
					type: "string",
					description: "Comma-separated priorities (OR-matched), e.g. urgent,high",
				},
				assignee: {
					type: "string",
					description: 'Filter by assignee user ID, or "me" for the calling user',
				},
				parentId: {
					type: "string",
					description:
						"Filter by parent issue ID, or a ref like PROJ-42 (returns direct children only)",
				},
				noParent: {
					type: "boolean",
					description: "Only return issues with no parent (top-level issues)",
				},
				typeId: { type: "string", description: "Filter by task type ID" },
				excludeTypeIds: {
					type: "string",
					description: "Comma-separated task type IDs to exclude (e.g. the epic type)",
				},
				sprintId: { type: "string", description: "Filter by sprint ID" },
				cfKey: { type: "string", description: "Custom field key to filter by" },
				cfOp: {
					type: "string",
					enum: ["eq", "gt", "gte", "lt", "lte"],
					description: "Comparison operator for the custom field filter (requires cfKey)",
				},
				cfValue: {
					type: "string",
					description: "Value to compare the custom field against (requires cfKey)",
				},
				completedAfter: {
					type: "number",
					description: "Only issues marked completed at or after this epoch-seconds time",
				},
				completedBefore: {
					type: "number",
					description: "Only issues marked completed at or before this epoch-seconds time",
				},
				updatedAfter: {
					type: "number",
					description: "Only issues last edited at or after this epoch-seconds time",
				},
				updatedBefore: {
					type: "number",
					description: "Only issues last edited at or before this epoch-seconds time",
				},
				needsAudit: {
					type: "boolean",
					description:
						"Filter to agent-initiated done-closures flagged for human audit — true for " +
						"unverifiable evidence, false for externally-checkable evidence",
				},
				includeRollups: {
					type: "boolean",
					description:
						"Attach a `rollup` of child status counts (total/byStatus/done/remaining) to each returned item",
				},
				includeBody: {
					type: "boolean",
					description: "Include the `body` field on each item (omitted by default)",
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
				projectId: {
					type: "string",
					description: "UUID of the project, or a project key like PROJ",
				},
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
					description: "UUID of the parent issue, or a ref like PROJ-42 (optional; max depth 5)",
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
		description:
			"Update an issue — status, priority, title, body, assignee, or labels. Review gating: " +
			"pass agentSessionId to identify yourself as an agent; entering in_review as " +
			"an agent requires completionReport. Agents CAN transition directly to done (no human " +
			"approval gate) — but if the completionReport.verification isn't externally checkable (no " +
			"CI run/PR/commit link), the issue is flagged needsAudit:true for after-the-fact human review.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "UUID of the issue, or a ref like PROJ-42" },
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
					description: "Set or clear the parent issue — UUID or ref like PROJ-42 (null to remove)",
				},
				typeId: { type: "string", nullable: true },
				agentSessionId: {
					type: "string",
					description:
						"Your agent session id (from register_agent) — identifies this update as agent-initiated",
				},
				completionReport: {
					type: "object",
					description:
						"Required when an agent moves an issue into in_review; also gates the done transition",
					properties: {
						summary: { type: "string" },
						verification: { type: "string" },
						prLink: { type: "string" },
					},
				},
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
				projectId: {
					type: "string",
					description: "Restrict search to a specific project — UUID or project key like PROJ",
				},
				limit: { type: "number", default: 20, description: "Max 50" },
			},
		},
		handler(input, ctx) {
			return searchIssues(ctx, input);
		},
	},
	{
		name: "delete_issue",
		description: "Delete an issue by ID or ref (e.g. PROJ-42)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "UUID of the issue, or a ref like PROJ-42" },
			},
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
			"Return open issues ranked by a composite score: link-network centrality (in-degree) + priority + " +
			"inverse story points. Useful for deciding what to work on next. By default, issues that fail the " +
			"definition-of-ready check (missing acceptance criteria, scope/files, or verification) are excluded.",
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
				excludeClaimed: {
					type: "boolean",
					default: false,
					description: "Skip issues currently held by a live lease (default false)",
				},
				includeNotReady: {
					type: "boolean",
					default: false,
					description:
						"Include issues that fail the definition-of-ready check, annotated with " +
						"needsGrooming and missingCriteria (default false)",
				},
				projectId: {
					type: "string",
					description:
						"Scope ranking to a single project's issues (default: workspace-wide, all visible projects)",
				},
			},
		},
		handler(input, ctx) {
			return getPrioritizedIssues(ctx, input);
		},
	},
];
