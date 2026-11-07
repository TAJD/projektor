import { z } from "zod";
import { CreateProjectSchema, UpdateProjectSchema } from "../schemas/projects";
import {
	createProject,
	deleteProject,
	getProject,
	getProjectBySlug,
	listProjects,
	updateProject,
} from "../services/projects";
import { defineOperation } from "./define";

const base = {
	domain: "projects",
	keywords: ["project", "board", "repo", "workstream", "archive", "key"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const projectOperations = [
	defineOperation({
		...base,
		id: "list_projects",
		method: "GET",
		path: "/api/workspaces/:slug/projects",
		tier: "read",
		summary: "List projects in the workspace. Archived projects are excluded by default.",
		input: z.object({
			includeArchived: z
				.boolean()
				.optional()
				.meta({ description: "Include archived projects in the results (default false)" }),
		}),
		run: (ctx, input) => listProjects(ctx, input),
	}),
	defineOperation({
		...base,
		id: "create_project",
		method: "POST",
		path: "/api/projects",
		tier: "write",
		minRole: "admin",
		status: 201,
		summary: "Create a new project in the workspace",
		input: CreateProjectSchema,
		run: (ctx, input) => createProject(ctx, input),
	}),
	defineOperation({
		...base,
		id: "get_project",
		method: "GET",
		path: "/api/projects/:id",
		tier: "read",
		summary: "Get a project by ID (or by its URL slug)",
		input: z.object({ id: z.string().meta({ description: "Project ID" }) }),
		run: (ctx, { id }) => (UUID_RE.test(id) ? getProject(ctx, id) : getProjectBySlug(ctx, id)),
	}),
	defineOperation({
		...base,
		id: "update_project",
		method: "PATCH",
		path: "/api/projects/:id",
		tier: "write",
		minRole: "admin",
		summary:
			"Update a project name, description, archived state, or epic-closing behaviour (owner/admin only). Set archived: true to hide it from the default project list, false to restore it. " +
			"epicAutoClose: true closes an epic automatically when its last child is done/cancelled; false (default) makes update_issue/finish_work return parentReadyToClose:{ref} instead.",
		input: UpdateProjectSchema.extend({ id: z.string().meta({ description: "Project ID" }) }),
		run: (ctx, { id, ...fields }) => updateProject(ctx, id, fields),
	}),
	defineOperation({
		...base,
		id: "delete_project",
		method: "DELETE",
		path: "/api/projects/:id",
		tier: "destructive",
		summary: "Delete a project and all its issues (owner only)",
		input: z.object({ id: z.string().min(1).meta({ description: "Project ID" }) }),
		run: (ctx, { id }) => deleteProject(ctx, id),
	}),
];
