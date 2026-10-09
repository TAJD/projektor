import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import {
	createTaskStatus,
	deleteTaskStatus,
	listTaskStatuses,
	updateTaskStatus,
} from "../services/task-statuses";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./annotations";

export const taskStatusesTools: MCPTool[] = [
	{
		name: "list_task_statuses",
		description: "List all task statuses configured for the workspace",
		inputSchema: {
			type: "object",
			properties: {},
		},
		annotations: READ,
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
				isReviewStep: {
					type: "boolean",
					description:
						"Mark this status as a review step (completion-report gate, review flow metrics). Not inferred from the key.",
				},
				isBacklog: {
					type: "boolean",
					description:
						"Count issues in this status as backlog on the project tile. Not inferred from the key.",
				},
			},
		},
		annotations: CREATE,
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
				isReviewStep: {
					type: "boolean",
					description:
						"Mark this status as a review step (completion-report gate, review flow metrics). Not inferred from the key.",
				},
				isBacklog: {
					type: "boolean",
					description:
						"Count issues in this status as backlog on the project tile. Not inferred from the key.",
				},
			},
		},
		annotations: IDEMPOTENT_WRITE,
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
		annotations: DESTRUCTIVE,
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return deleteTaskStatus(ctx, id);
		},
	},
];
