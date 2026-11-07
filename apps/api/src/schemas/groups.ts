import { z } from "zod";

// PROJ-311: grant roles are the per-project subset of workspace roles (no owner).
export const GrantRoleEnum = z.enum(["viewer", "member", "admin"]);

export const CreateGroupSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(100)
		.meta({ description: "Group name, unique per workspace (max 100)" }),
	description: z
		.string()
		.max(500)
		.nullable()
		.optional()
		.meta({ description: "Optional description (max 500)" }),
});

export const UpdateGroupSchema = z.object({
	name: z.string().min(1).max(100).optional().meta({ description: "New group name" }),
	description: z.string().max(500).nullable().optional().meta({ description: "New description" }),
});

export const AddGroupMemberSchema = z.object({
	userId: z
		.string()
		.min(1, "userId is required")
		.meta({ description: "User ID (must be a workspace member)" }),
});

export const SetGroupGrantSchema = z.object({
	projectId: z.string().min(1, "projectId is required").meta({ description: "Project ID" }),
	role: GrantRoleEnum.meta({ description: "Role members of this group get inside the project" }),
});
