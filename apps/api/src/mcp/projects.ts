import type { MCPTool } from "@projektor/types";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	updateProject,
} from "../services/projects";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./annotations";

export const projectsTools: MCPTool[] = [
	{
		name: "list_projects",
		description: "List projects in the workspace. Archived projects are excluded by default.",
		inputSchema: {
			type: "object",
			properties: {
				includeArchived: {
					type: "boolean",
					description: "Include archived projects in the results (default false)",
				},
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { includeArchived } = (input ?? {}) as { includeArchived?: boolean };
			return listProjects(ctx, { includeArchived });
		},
	},
	{
		name: "create_project",
		description: "Create a new project in the workspace",
		inputSchema: {
			type: "object",
			required: ["name", "key"],
			properties: {
				name: { type: "string", description: "Project name, max 100 characters" },
				key: {
					type: "string",
					description: "Short uppercase identifier, e.g. PROJ (max 10 chars, A-Z0-9)",
				},
				description: { type: "string", description: "Optional description, max 500 characters" },
			},
		},
		annotations: CREATE,
		async handler(input, ctx) {
			return createProject(ctx, input);
		},
	},
	{
		name: "get_project",
		description: "Get a project by ID",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string", description: "Project ID" } },
		},
		annotations: READ,
		async handler(input, ctx) {
			const { id } = input as { id: string };
			return getProject(ctx, id);
		},
	},
	{
		name: "update_project",
		description:
			"Update a project name, description, or archived state (owner/admin only). Set archived: true to hide it from the default project list, false to restore it.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "Project ID" },
				name: { type: "string", description: "New project name" },
				description: { type: "string", description: "New description" },
				archived: { type: "boolean", description: "Archive (true) or unarchive (false)" },
			},
		},
		annotations: IDEMPOTENT_WRITE,
		async handler(input, ctx) {
			const { id, ...fields } = input as { id: string; [k: string]: unknown };
			return updateProject(ctx, id, fields);
		},
	},
	{
		name: "delete_project",
		description: "Delete a project and all its issues (owner only)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string", description: "Project ID" } },
		},
		annotations: DESTRUCTIVE,
		async handler(input, ctx) {
			const { id } = input as { id: string };
			return deleteProject(ctx, id);
		},
	},
];
