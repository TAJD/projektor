import { drizzle, schema } from "@projektor/db";
import type { MCPTool } from "@projektor/types";
import { eq } from "drizzle-orm";
import { DeleteWorkspaceInput } from "../schemas/workspaces";
import { NotFoundError, ValidationError } from "../services/errors";
import {
	createWorkspace,
	deleteWorkspace,
	getWorkspaceWithMembers,
	inviteMember,
	listUserWorkspaces,
	removeMember,
	updateMemberRole,
	updateWorkspace,
} from "../services/workspaces";

export const workspacesTools: MCPTool[] = [
	{
		name: "list_workspaces",
		description: "List all workspaces the authenticated user belongs to, with their role in each",
		inputSchema: { type: "object", properties: {} },
		async handler(_input, ctx) {
			return listUserWorkspaces(ctx.db, ctx.userId);
		},
	},
	{
		name: "create_workspace",
		description:
			"Create a new workspace and add the caller as owner. Seeds default task types, statuses, and custom fields.",
		inputSchema: {
			type: "object",
			required: ["slug", "name"],
			properties: {
				slug: {
					type: "string",
					description: 'URL-safe identifier for the workspace (e.g. "my-team")',
				},
				name: { type: "string", description: "Human-readable display name for the workspace" },
			},
		},
		async handler(input, ctx) {
			return createWorkspace(ctx.db, ctx.userId, input);
		},
	},
	{
		name: "delete_workspace",
		description:
			"Permanently delete a workspace. Owner-only. The default workspace cannot be deleted. " +
			"All projects must be removed first.",
		inputSchema: {
			type: "object",
			required: ["workspaceSlug"],
			properties: {
				workspaceSlug: {
					type: "string",
					description: "Slug of the workspace to delete",
				},
			},
		},
		async handler(input, ctx) {
			const parsed = DeleteWorkspaceInput.safeParse(input);
			if (!parsed.success) throw new ValidationError(parsed.error.flatten());
			const { workspaceSlug } = parsed.data;

			const orm = drizzle(ctx.db, { schema });
			const ws = await orm
				.select({ id: schema.workspaces.id })
				.from(schema.workspaces)
				.where(eq(schema.workspaces.slug, workspaceSlug))
				.get();
			if (!ws) throw new NotFoundError("Workspace not found");

			return deleteWorkspace({ ...ctx, workspaceId: ws.id }, "projektor");
		},
	},
	{
		name: "update_workspace",
		description: "Rename the current workspace. Admin+ only.",
		inputSchema: {
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string", description: "New display name for the workspace" },
			},
		},
		async handler(input, ctx) {
			return updateWorkspace(ctx, input);
		},
	},
	{
		name: "list_members",
		description: "List all members of the current workspace with their roles",
		inputSchema: { type: "object", properties: {} },
		async handler(_input, ctx) {
			const orm = drizzle(ctx.db, { schema });
			const ws = await orm
				.select({
					id: schema.workspaces.id,
					name: schema.workspaces.name,
					slug: schema.workspaces.slug,
				})
				.from(schema.workspaces)
				.where(eq(schema.workspaces.id, ctx.workspaceId))
				.get();
			if (!ws) throw new NotFoundError("Workspace not found");
			const result = await getWorkspaceWithMembers(ctx, ws);
			return result.members;
		},
	},
	{
		name: "invite_member",
		description:
			"Invite a user to the workspace by email. Admin+ only. Creates the user record if they do not exist yet.",
		inputSchema: {
			type: "object",
			required: ["email", "role"],
			properties: {
				email: { type: "string", description: "Email address of the user to invite" },
				role: {
					type: "string",
					enum: ["owner", "admin", "member", "viewer"],
					description: "Role to assign to the invited user",
				},
			},
		},
		async handler(input, ctx) {
			return inviteMember(ctx, input);
		},
	},
	{
		name: "remove_member",
		description: "Remove a member from the workspace. Owner only. Cannot remove yourself.",
		inputSchema: {
			type: "object",
			required: ["userId"],
			properties: {
				userId: { type: "string", description: "ID of the user to remove" },
			},
		},
		async handler(input, ctx) {
			const { userId } = input as { userId: string };
			return removeMember(ctx, userId);
		},
	},
	{
		name: "update_member_role",
		description: "Change a workspace member's role. Owner only.",
		inputSchema: {
			type: "object",
			required: ["userId", "role"],
			properties: {
				userId: { type: "string", description: "ID of the user whose role to change" },
				role: {
					type: "string",
					enum: ["owner", "admin", "member", "viewer"],
					description: "New role to assign",
				},
			},
		},
		async handler(input, ctx) {
			const { userId, role } = input as { userId: string; role: string };
			return updateMemberRole(ctx, userId, { role });
		},
	},
];
