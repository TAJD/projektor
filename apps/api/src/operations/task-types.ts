import { z } from "zod";
import { CreateTaskTypeSchema, UpdateTaskTypeFields } from "../schemas/task-types";
import {
	createTaskType,
	deleteTaskType,
	listTaskTypes,
	updateTaskType,
} from "../services/task-types";
import { defineOperation } from "./define";

const id = z.string().min(1).meta({ description: "Task type id" });
const base = { domain: "task-types", keywords: ["issue type", "kind", "category"] };

export const taskTypeOperations = [
	defineOperation({
		...base,
		id: "list_task_types",
		method: "GET",
		path: "/api/task-types",
		tier: "read",
		summary: "List all task types configured for the workspace",
		input: z.object({}),
		run: (ctx) => listTaskTypes(ctx),
	}),
	defineOperation({
		...base,
		id: "create_task_type",
		method: "POST",
		path: "/api/task-types",
		tier: "write",
		minRole: "admin",
		status: 201,
		summary: "Create a new task type for the workspace (owner/admin only)",
		input: CreateTaskTypeSchema,
		run: (ctx, input) => createTaskType(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_task_type",
		method: "PATCH",
		path: "/api/task-types/:id",
		tier: "write",
		minRole: "admin",
		summary: "Update a task type (owner/admin only)",
		input: UpdateTaskTypeFields.extend({ id }),
		run: (ctx, { id, ...fields }) => updateTaskType(ctx, id, fields),
	}),
	defineOperation({
		...base,
		id: "delete_task_type",
		method: "DELETE",
		path: "/api/task-types/:id",
		tier: "destructive",
		minRole: "admin",
		summary: "Delete a task type (owner/admin only). Fails if the type is in use by any issues.",
		input: z.object({ id }),
		run: (ctx, { id }) => deleteTaskType(ctx, id),
	}),
];
