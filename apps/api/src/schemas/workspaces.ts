import { z } from "zod";
import { ScopeSchema } from "../auth/scopes";
import { RoleEnum } from "./common";

export const CreateWorkspaceSchema = z.object({
	name: z.string().min(1).max(100),
	slug: z
		.string()
		.min(2)
		.max(50)
		.regex(/^[a-z0-9-]+$/),
});

export const UpdateWorkspaceSchema = z.object({
	name: z.string().min(1).max(100),
});

export const InviteMemberSchema = z.object({
	email: z.string().email(),
	role: RoleEnum.default("member"),
});

export const UpdateRoleSchema = z.object({
	role: RoleEnum,
});

export const CreateTokenSchema = z.object({
	name: z.string().min(1).max(100),
	scopes: z.array(ScopeSchema).min(1).default(["read", "write"]),
	expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const DeleteWorkspaceInput = z.object({
	workspaceSlug: z.string(),
});
