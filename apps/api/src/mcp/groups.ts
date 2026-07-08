import type { MCPTool } from "@projektor/types";
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
import type { ServiceCtx } from "../services/types";

export const groupsTools: MCPTool[] = [
	{
		name: "list_groups",
		description:
			"List access groups. Owner/admin see all groups in the workspace; other members see only groups they belong to.",
		inputSchema: { type: "object", properties: {} },
		async handler(_input, ctx) {
			return listGroups(ctx as ServiceCtx);
		},
	},
	{
		name: "get_group",
		description: "Get an access group with its members and project grants",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string", description: "Group ID" } },
		},
		async handler(input, ctx) {
			const { id } = input as { id: string };
			return getGroup(ctx as ServiceCtx, id);
		},
	},
	{
		name: "list_member_groups",
		description:
			"List every workspace member with the access groups they belong to (owner/admin only). Members with no groups appear with an empty list — the pending/default-deny state.",
		inputSchema: { type: "object", properties: {} },
		async handler(_input, ctx) {
			return listMemberGroups(ctx as ServiceCtx);
		},
	},
	{
		name: "create_group",
		description: "Create an access group (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string", description: "Group name, unique per workspace (max 100)" },
				description: { type: "string", description: "Optional description (max 500)" },
			},
		},
		async handler(input, ctx) {
			return createGroup(ctx as ServiceCtx, input);
		},
	},
	{
		name: "update_group",
		description: "Rename an access group or change its description (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "Group ID" },
				name: { type: "string", description: "New group name" },
				description: { type: "string", description: "New description" },
			},
		},
		async handler(input, ctx) {
			const { id, ...fields } = input as { id: string; [k: string]: unknown };
			return updateGroup(ctx as ServiceCtx, id, fields);
		},
	},
	{
		name: "delete_group",
		description:
			"Delete an access group; its memberships and project grants cascade (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string", description: "Group ID" } },
		},
		async handler(input, ctx) {
			const { id } = input as { id: string };
			return deleteGroup(ctx as ServiceCtx, id);
		},
	},
	{
		name: "add_group_member",
		description: "Add a workspace member to an access group (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["groupId", "userId"],
			properties: {
				groupId: { type: "string", description: "Group ID" },
				userId: { type: "string", description: "User ID (must be a workspace member)" },
			},
		},
		async handler(input, ctx) {
			const { groupId, ...fields } = input as { groupId: string; [k: string]: unknown };
			return addGroupMember(ctx as ServiceCtx, groupId, fields);
		},
	},
	{
		name: "remove_group_member",
		description: "Remove a member from an access group (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["groupId", "userId"],
			properties: {
				groupId: { type: "string", description: "Group ID" },
				userId: { type: "string", description: "User ID" },
			},
		},
		async handler(input, ctx) {
			const { groupId, userId } = input as { groupId: string; userId: string };
			return removeGroupMember(ctx as ServiceCtx, groupId, userId);
		},
	},
	{
		name: "set_group_grant",
		description:
			"Grant an access group a role on a project (upsert — changes the role if a grant already exists). Owner/admin only.",
		inputSchema: {
			type: "object",
			required: ["groupId", "projectId", "role"],
			properties: {
				groupId: { type: "string", description: "Group ID" },
				projectId: { type: "string", description: "Project ID" },
				role: {
					type: "string",
					enum: ["viewer", "member", "admin"],
					description: "Role members of this group get inside the project",
				},
			},
		},
		async handler(input, ctx) {
			const { groupId, ...fields } = input as { groupId: string; [k: string]: unknown };
			return setGroupGrant(ctx as ServiceCtx, groupId, fields);
		},
	},
	{
		name: "remove_group_grant",
		description: "Remove an access group's grant on a project (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["groupId", "projectId"],
			properties: {
				groupId: { type: "string", description: "Group ID" },
				projectId: { type: "string", description: "Project ID" },
			},
		},
		async handler(input, ctx) {
			const { groupId, projectId } = input as { groupId: string; projectId: string };
			return removeGroupGrant(ctx as ServiceCtx, groupId, projectId);
		},
	},
];
