import { z } from "zod";

// PROJ-311: grant roles are the per-project subset of workspace roles (no owner).
// cofferdam-ignore: Design.OrphanExport: exported for schema-module consistency, used only within this file today
export const GrantRoleEnum = z.enum(["viewer", "member", "admin"]);

export const CreateGroupSchema = z.object({
	name: z.string().min(1).max(100),
	description: z.string().max(500).nullable().optional(),
});

export const UpdateGroupSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(500).nullable().optional(),
});

export const AddGroupMemberSchema = z.object({
	userId: z.string().min(1, "userId is required"),
});

export const SetGroupGrantSchema = z.object({
	projectId: z.string().min(1, "projectId is required"),
	role: GrantRoleEnum,
});
