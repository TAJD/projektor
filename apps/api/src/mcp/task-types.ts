import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import {
	createTaskType,
	deleteTaskType,
	listTaskTypes,
	updateTaskType,
} from "../services/task-types";

export const taskTypesTools: MCPTool[] = [
	{
		name: "list_task_types",
		description: "List all task types configured for the workspace",
		inputSchema: {
			type: "object",
			properties: {},
		},
		handler(_input, ctx) {
			return listTaskTypes(ctx);
		},
	},
	{
		name: "create_task_type",
		description: "Create a new task type for the workspace (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["key", "name"],
			properties: {
				key: { type: "string", description: "Unique key (lowercase letters, digits, underscores)" },
				name: { type: "string", description: "Display name" },
				color: { type: "string", description: "Optional color (hex or named)" },
				icon: { type: "string", description: "Optional icon identifier" },
				position: { type: "number", description: "Sort order position" },
				isDefault: { type: "boolean", description: "Set as the default type for new issues" },
			},
		},
		handler(input, ctx) {
			return createTaskType(ctx, input);
		},
	},
	{
		name: "update_task_type",
		description: "Update a task type (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				color: { type: "string", nullable: true },
				icon: { type: "string", nullable: true },
				position: { type: "number" },
				isDefault: { type: "boolean", description: "Set as the default type for new issues" },
			},
		},
		handler(input, ctx) {
			const { id, ...fields } = input as { id?: string; [k: string]: unknown };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return updateTaskType(ctx, id, fields);
		},
	},
	{
		name: "delete_task_type",
		description:
			"Delete a task type (owner/admin only). Fails if the type is in use by any issues.",
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
			return deleteTaskType(ctx, id);
		},
	},
];
