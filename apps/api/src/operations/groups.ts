import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import {
	AddGroupMemberSchema,
	CreateGroupSchema,
	SetGroupGrantSchema,
	UpdateGroupSchema,
} from "../schemas/groups";
import {
	addGroupMember,
	createGroup,
	deleteGroup,
	getGroup,
	listGroups,
	listMemberGroups,
	removeGroupGrant,
	removeGroupMember,
	setGroupGrant,
	updateGroup,
} from "../services/groups";
import { defineOperation } from "./define";

const base = {
	domain: "groups",
	keywords: ["access", "permission", "team", "role", "grant", "membership"],
};

const GROUPS = "/api/workspaces/:slug/groups";
const GroupId = z.string().min(1).meta({ description: "Group ID" });

export const groupOperations = [
	defineOperation({
		...base,
		id: "list_groups",
		method: "GET",
		path: GROUPS,
		tier: "read",
		summary:
			"List access groups. Owner/admin see all groups in the workspace; other members see only groups they belong to.",
		input: z.object({}),
		run: (ctx) => listGroups(ctx),
	}),
	defineOperation({
		...base,
		id: "get_group",
		method: "GET",
		path: `${GROUPS}/:id`,
		tier: "read",
		summary: "Get an access group with its members and project grants",
		input: z.object({ id: GroupId }),
		run: (ctx, { id }) => getGroup(ctx, id),
	}),
	defineOperation({
		...base,
		id: "list_member_groups",
		method: "GET",
		path: "/api/workspaces/:slug/member-groups",
		tier: "read",
		minRole: "admin",
		summary:
			"List every workspace member with the access groups they belong to (owner/admin only). " +
			"Members with no groups appear with an empty list — the pending/default-deny state.",
		input: z.object({}),
		run: (ctx) => listMemberGroups(ctx),
	}),
	defineOperation({
		...base,
		id: "create_group",
		method: "POST",
		path: GROUPS,
		tier: "write",
		minRole: "admin",
		status: 201,
		summary: "Create an access group (owner/admin only)",
		input: CreateGroupSchema,
		run: (ctx, input) => createGroup(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_group",
		method: "PATCH",
		path: `${GROUPS}/:id`,
		tier: "write",
		minRole: "admin",
		summary: "Rename an access group or change its description (owner/admin only)",
		input: UpdateGroupSchema.extend({ id: GroupId }),
		run: (ctx, { id, ...fields }) => updateGroup(ctx, id, fields),
	}),
	defineOperation({
		...base,
		id: "delete_group",
		method: "DELETE",
		path: `${GROUPS}/:id`,
		tier: "destructive",
		minRole: "admin",
		summary:
			"Delete an access group; its memberships and project grants cascade (owner/admin only)",
		input: z.object({ id: GroupId }),
		run: (ctx, { id }) => deleteGroup(ctx, id),
	}),
	defineOperation({
		...base,
		id: "add_group_member",
		method: "POST",
		path: `${GROUPS}/:groupId/members`,
		tier: "write",
		annotations: PLAIN_WRITE,
		minRole: "admin",
		status: 201,
		summary: "Add a workspace member to an access group (owner/admin only)",
		input: AddGroupMemberSchema.extend({ groupId: GroupId }),
		run: (ctx, { groupId, ...fields }) => addGroupMember(ctx, groupId, fields),
	}),
	defineOperation({
		...base,
		id: "remove_group_member",
		method: "DELETE",
		path: `${GROUPS}/:groupId/members/:userId`,
		tier: "destructive",
		minRole: "admin",
		summary: "Remove a member from an access group (owner/admin only)",
		input: z.object({
			groupId: GroupId,
			userId: z.string().min(1).meta({ description: "User ID" }),
		}),
		run: (ctx, { groupId, userId }) => removeGroupMember(ctx, groupId, userId),
	}),
	defineOperation({
		...base,
		id: "set_group_grant",
		method: "PUT",
		path: `${GROUPS}/:groupId/grants`,
		tier: "write",
		minRole: "admin",
		summary:
			"Grant an access group a role on a project (upsert — changes the role if a grant already exists). Owner/admin only.",
		input: SetGroupGrantSchema.extend({ groupId: GroupId }),
		run: (ctx, { groupId, ...fields }) => setGroupGrant(ctx, groupId, fields),
	}),
	defineOperation({
		...base,
		id: "remove_group_grant",
		method: "DELETE",
		path: `${GROUPS}/:groupId/grants/:projectId`,
		tier: "destructive",
		minRole: "admin",
		summary: "Remove an access group's grant on a project (owner/admin only)",
		input: z.object({
			groupId: GroupId,
			projectId: z.string().min(1).meta({ description: "Project ID" }),
		}),
		run: (ctx, { groupId, projectId }) => removeGroupGrant(ctx, groupId, projectId),
	}),
];
