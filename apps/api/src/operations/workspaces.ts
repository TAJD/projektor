import { z } from "zod";
import { DESTRUCTIVE, PLAIN_WRITE } from "../mcp/annotations";
import {
	CreateWorkspaceSchema,
	DeleteWorkspaceInput,
	InviteMemberSchema,
	UpdateRoleSchema,
	UpdateWorkspaceBrandSchema,
	UpdateWorkspaceSchema,
} from "../schemas/workspaces";
import type { ServiceCtx } from "../services/types";
import {
	createWorkspace,
	deleteWorkspace,
	getWorkspaceBrand,
	getWorkspaceWithMembers,
	inviteMember,
	listWorkspaces,
	removeMember,
	updateMemberRole,
	updateWorkspace,
	updateWorkspaceBrand,
} from "../services/workspaces";
import { defineOperation } from "./define";

const base = {
	domain: "workspaces",
	keywords: ["workspace", "organisation", "tenant", "member", "invite", "team", "brand"],
};

const WS = "/api/workspaces/:slug";

function current(ctx: ServiceCtx) {
	const { workspaceId: id, workspaceSlug: slug, workspaceName: name } = ctx;
	if (slug === undefined || name === undefined) throw new Error("workspace context missing");
	return { id, slug, name };
}

export const workspaceOperations = [
	defineOperation({
		...base,
		id: "list_workspaces",
		method: "GET",
		path: "/api/workspaces",
		tier: "read",
		workspace: false,
		summary: "List all workspaces the authenticated user belongs to, with their role in each",
		input: z.object({}),
		run: (ctx) => listWorkspaces(ctx.db, ctx.userId),
	}),
	defineOperation({
		...base,
		id: "create_workspace",
		method: "POST",
		path: "/api/workspaces",
		tier: "write",
		workspace: false,
		status: 201,
		summary:
			"Create a new workspace and add the caller as owner. Seeds default task types, statuses, and custom fields.",
		input: CreateWorkspaceSchema,
		run: (ctx, input) => createWorkspace(ctx.db, ctx.userId, input),
	}),
	defineOperation({
		...base,
		id: "delete_workspace",
		method: "DELETE",
		path: "/api/workspaces/:workspaceSlug",
		tier: "destructive",
		summary:
			"Permanently delete a workspace. Owner-only. The default workspace cannot be deleted. " +
			"All projects must be removed first.",
		input: DeleteWorkspaceInput,
		run: (ctx, { workspaceSlug }) =>
			deleteWorkspace(ctx, workspaceSlug, ctx.config?.defaultWorkspaceSlug ?? "projektor"),
	}),
	defineOperation({
		...base,
		id: "update_workspace",
		method: "PATCH",
		path: WS,
		tier: "write",
		minRole: "admin",
		summary: "Rename the current workspace. Admin+ only.",
		input: UpdateWorkspaceSchema,
		run: (ctx, input) => updateWorkspace(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_members",
		method: "GET",
		path: WS,
		tier: "read",
		summary: "List all members of the current workspace with their roles",
		input: z.object({}),
		run: (ctx) => getWorkspaceWithMembers(ctx, current(ctx)),
		mcpResult: (result) => (result as { members: unknown }).members,
	}),
	defineOperation({
		...base,
		id: "invite_member",
		method: "POST",
		path: `${WS}/members`,
		tier: "write",
		annotations: PLAIN_WRITE,
		minRole: "admin",
		status: 201,
		summary:
			"Invite a user to the workspace by email. Admin+ only. Creates the user record if they do not exist yet.",
		input: InviteMemberSchema,
		run: (ctx, input) => inviteMember(ctx, input),
	}),
	defineOperation({
		...base,
		id: "remove_member",
		method: "DELETE",
		path: `${WS}/members/:userId`,
		tier: "destructive",
		summary: "Remove a member from the workspace. Owner only. Cannot remove yourself.",
		input: z.object({
			userId: z.string().min(1).meta({ description: "ID of the user to remove" }),
		}),
		run: (ctx, { userId }) => removeMember(ctx, userId),
	}),
	defineOperation({
		...base,
		id: "update_member_role",
		method: "PATCH",
		path: `${WS}/members/:userId`,
		tier: "write",
		annotations: DESTRUCTIVE,
		minRole: "owner",
		summary: "Change a workspace member's role. Owner only.",
		input: UpdateRoleSchema.extend({
			userId: z.string().min(1).meta({ description: "ID of the user whose role to change" }),
		}),
		run: (ctx, { userId, ...fields }) => updateMemberRole(ctx, userId, fields),
	}),
	defineOperation({
		...base,
		id: "get_workspace_brand",
		method: "GET",
		path: `${WS}/brand`,
		tier: "read",
		summary:
			"Get the current workspace's white-label branding overrides (display name, accent colors, logo, font). Unset fields are null.",
		input: z.object({}),
		run: (ctx) => getWorkspaceBrand(ctx, current(ctx).slug),
	}),
	defineOperation({
		...base,
		id: "update_workspace_brand",
		method: "PATCH",
		path: `${WS}/brand`,
		tier: "write",
		minRole: "admin",
		summary:
			"Update the current workspace's white-label branding overrides. Admin+ only. Pass a field as null to clear it back to the deploy-level default; omit a field to leave it unchanged.",
		input: UpdateWorkspaceBrandSchema,
		run: (ctx, input) => updateWorkspaceBrand(ctx, current(ctx).slug, input),
	}),
];
