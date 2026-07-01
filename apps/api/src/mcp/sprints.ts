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
				id: { type: "string", description: "Sprint UUID" },
			},
		},
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
				name: { type: "string" },
				goal: { type: "string", description: "Sprint goal description" },
				startDate: { type: "number", description: "Unix timestamp for sprint start" },
				endDate: { type: "number", description: "Unix timestamp for sprint end" },
			},
		},
		handler(input, ctx) {
			return createSprint(ctx, input);
		},
	},
	{
		name: "update_sprint",
		description: "Update sprint fields - name, goal, status, start/end dates",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				goal: { type: "string", nullable: true },
				status: { type: "string", enum: ["planned", "active", "completed"] },
				startDate: { type: "number", nullable: true },
				endDate: { type: "number", nullable: true },
			},
		},
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
				id: { type: "string", description: "Sprint UUID" },
			},
		},
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
				id: { type: "string", description: "Sprint UUID" },
			},
		},
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
					items: { type: "string" },
					description: "Issue UUIDs to move (max 500)",
				},
			},
		},
		handler(input, ctx) {
			return moveIssuesToSprint(ctx, input);
		},
	},
];
