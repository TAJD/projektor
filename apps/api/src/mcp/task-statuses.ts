import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import {
	createTaskStatus,
	deleteTaskStatus,
	listTaskStatuses,
	updateTaskStatus,
} from "../services/task-statuses";

export const taskStatusesTools: MCPTool[] = [
	{
		name: "list_task_statuses",
		description: "List all task statuses configured for the workspace",
		inputSchema: {
			type: "object",
			properties: {},
		},
		handler(_input, ctx) {
			return listTaskStatuses(ctx);
		},
	},
	{
		name: "create_task_status",
		description: "Create a new task status for the workspace (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["key", "name", "category"],
			properties: {
				key: { type: "string", description: "Unique key (lowercase letters, digits, underscores)" },
				name: { type: "string", description: "Display name" },
				category: {
					type: "string",
					enum: ["todo", "in_progress", "done", "cancelled"],
					description: "Workflow bucket",
				},
				color: { type: "string", description: "Optional color (hex or named)" },
				position: { type: "number", description: "Sort order position" },
				isDefault: { type: "boolean", description: "Set as the default status for new issues" },
			},
		},
		handler(input, ctx) {
			return createTaskStatus(ctx, input);
		},
	},
	{
		name: "update_task_status",
		description: "Update a task status (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				category: { type: "string", enum: ["todo", "in_progress", "done", "cancelled"] },
				color: { type: "string", nullable: true },
				position: { type: "number" },
				isDefault: { type: "boolean", description: "Set as the default status for new issues" },
			},
		},
		handler(input, ctx) {
			const { id, ...fields } = input as { id?: string; [k: string]: unknown };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return updateTaskStatus(ctx, id, fields);
		},
	},
	{
		name: "delete_task_status",
		description:
			"Delete a task status (owner/admin only). Fails if the status is in use or is the default.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
			},
		},
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return deleteTaskStatus(ctx, id);
		},
	},
];
