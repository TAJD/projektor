import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import {
	CreateSprintSchema,
	ListSprintsSchema,
	MoveIssuesToSprintSchema,
	UpdateSprintFields,
} from "../schemas/sprints";
import {
	completeSprint,
	createSprint,
	deleteSprint,
	getSprint,
	listSprints,
	moveIssuesToSprint,
	updateSprint,
} from "../services/sprints";
import { defineOperation } from "./define";

const base = {
	domain: "sprints",
	keywords: ["iteration", "cycle", "milestone", "timebox", "plan", "schedule"],
};

const SprintId = z.object({ id: z.string().min(1).meta({ description: "Sprint UUID" }) });

export const sprintOperations = [
	defineOperation({
		...base,
		id: "list_sprints",
		method: "GET",
		path: "/api/sprints",
		tier: "read",
		summary: "List sprints for a project, ordered by creation date",
		input: ListSprintsSchema,
		run: (ctx, input) => listSprints(ctx, input),
	}),
	defineOperation({
		...base,
		id: "get_sprint",
		method: "GET",
		path: "/api/sprints/:id",
		tier: "read",
		summary: "Get a sprint by ID",
		input: SprintId,
		run: (ctx, { id }) => getSprint(ctx, id),
	}),
	defineOperation({
		...base,
		id: "create_sprint",
		method: "POST",
		path: "/api/sprints",
		tier: "write",
		status: 201,
		summary: "Create a new sprint in a project",
		input: CreateSprintSchema,
		run: (ctx, input) => createSprint(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_sprint",
		method: "PATCH",
		path: "/api/sprints/:id",
		tier: "write",
		summary: "Update sprint fields — name, goal, status, start/end dates",
		input: UpdateSprintFields.extend({ id: z.string().min(1) }),
		run: (ctx, { id, ...fields }) => updateSprint(ctx, id, fields),
	}),
	defineOperation({
		...base,
		id: "complete_sprint",
		method: "POST",
		path: "/api/sprints/:id/complete",
		tier: "write",
		annotations: PLAIN_WRITE,
		summary: "Mark an active sprint as completed",
		input: SprintId,
		run: (ctx, { id }) => completeSprint(ctx, id),
	}),
	defineOperation({
		...base,
		id: "delete_sprint",
		method: "DELETE",
		path: "/api/sprints/:id",
		tier: "destructive",
		summary: "Delete a sprint (issues in the sprint will have their sprint_id cleared)",
		input: SprintId,
		run: (ctx, { id }) => deleteSprint(ctx, id),
	}),
	defineOperation({
		...base,
		id: "move_issues_to_sprint",
		method: "POST",
		path: "/api/sprints/:sprintId/move-issues",
		tier: "write",
		annotations: PLAIN_WRITE,
		summary: "Bulk move issues into a sprint by setting their sprint_id",
		input: MoveIssuesToSprintSchema,
		run: (ctx, input) => moveIssuesToSprint(ctx, input),
	}),
];
