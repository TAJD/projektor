import { z } from "zod";
import { CreateTaskStatusSchema, UpdateTaskStatusFields } from "../schemas/task-statuses";
import {
	createTaskStatus,
	deleteTaskStatus,
	listTaskStatuses,
	updateTaskStatus,
} from "../services/task-statuses";
import { defineOperation } from "./define";

const id = z.string().min(1).meta({ description: "Task status id" });
const base = { domain: "task-statuses", keywords: ["status", "workflow", "column", "state"] };

export const taskStatusOperations = [
	defineOperation({
		...base,
		id: "list_task_statuses",
		method: "GET",
		path: "/api/task-statuses",
		tier: "read",
		summary: "List all task statuses configured for the workspace",
		input: z.object({}),
		run: (ctx) => listTaskStatuses(ctx),
	}),
	defineOperation({
		...base,
		id: "create_task_status",
		method: "POST",
		path: "/api/task-statuses",
		tier: "write",
		minRole: "admin",
		status: 201,
		summary: "Create a new task status for the workspace (owner/admin only)",
		input: CreateTaskStatusSchema,
		run: (ctx, input) => createTaskStatus(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_task_status",
		method: "PATCH",
		path: "/api/task-statuses/:id",
		tier: "write",
		minRole: "admin",
		summary: "Update a task status (owner/admin only)",
		input: UpdateTaskStatusFields.extend({ id }),
		run: (ctx, { id, ...fields }) => updateTaskStatus(ctx, id, fields),
	}),
	defineOperation({
		...base,
		id: "delete_task_status",
		method: "DELETE",
		path: "/api/task-statuses/:id",
		tier: "destructive",
		minRole: "admin",
		summary:
			"Delete a task status (owner/admin only). Fails if the status is in use or is the default.",
		input: z.object({ id }),
		run: (ctx, { id }) => deleteTaskStatus(ctx, id),
	}),
];
