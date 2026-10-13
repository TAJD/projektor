import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import {
	completeSprint,
	createSprint,
	deleteSprint,
	getSprint,
	listSprints,
	moveIssuesToSprint,
	updateSprint,
} from "../services/sprints";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, PLAIN_WRITE, READ } from "./annotations";

export const sprintsTools: MCPTool[] = [
	{
		name: "list_sprints",
		description: "List sprints for a project, ordered by creation date",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: {
				projectId: { type: "string", description: "Project UUID" },
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return listSprints(ctx, input);
		},
	},
	{
		name: "get_sprint",
		description: "Get a sprint by ID",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", minLength: 1, description: "Sprint UUID" },
			},
		},
		annotations: READ,
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return getSprint(ctx, id);
		},
	},
	{
		name: "create_sprint",
		description: "Create a new sprint in a project",
		inputSchema: {
			type: "object",
			required: ["projectId", "name"],
			properties: {
				projectId: { type: "string" },
				name: { type: "string", minLength: 1, maxLength: 255 },
				goal: { type: "string", maxLength: 2000, description: "Sprint goal description" },
				startDate: { type: "integer", description: "Unix timestamp for sprint start" },
				endDate: { type: "integer", description: "Unix timestamp for sprint end" },
			},
		},
		annotations: CREATE,
		handler(input, ctx) {
			return createSprint(ctx, input);
		},
	},
	{
		name: "update_sprint",
		description: "Update sprint fields — name, goal, status, start/end dates",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", minLength: 1 },
				name: { type: "string", minLength: 1, maxLength: 255 },
				goal: { type: "string", nullable: true, maxLength: 2000 },
				status: { type: "string", enum: ["planned", "active", "completed"] },
				startDate: { type: "integer", nullable: true },
				endDate: { type: "integer", nullable: true },
			},
		},
		annotations: IDEMPOTENT_WRITE,
		handler(input, ctx) {
			const { id, ...fields } = input as { id?: string; [k: string]: unknown };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return updateSprint(ctx, id, fields);
		},
	},
	{
		name: "complete_sprint",
		description: "Mark an active sprint as completed",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", minLength: 1, description: "Sprint UUID" },
			},
		},
		annotations: PLAIN_WRITE,
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return completeSprint(ctx, id);
		},
	},
	{
		name: "delete_sprint",
		description: "Delete a sprint (issues in the sprint will have their sprint_id cleared)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", minLength: 1, description: "Sprint UUID" },
			},
		},
		annotations: DESTRUCTIVE,
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return deleteSprint(ctx, id);
		},
	},
	{
		name: "move_issues_to_sprint",
		description: "Bulk move issues into a sprint by setting their sprint_id",
		inputSchema: {
			type: "object",
			required: ["sprintId", "issueIds"],
			properties: {
				sprintId: { type: "string", description: "Target sprint UUID" },
				issueIds: {
					type: "array",
					minItems: 1,
					maxItems: 500,
					items: { type: "string", minLength: 1 },
					description: "Issue UUIDs or refs like PROJ-42, may be mixed (max 500)",
				},
			},
		},
		annotations: PLAIN_WRITE,
		handler(input, ctx) {
			return moveIssuesToSprint(ctx, input);
		},
	},
];
