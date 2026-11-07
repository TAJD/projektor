import { z } from "zod";
import { ScopeSchema } from "../auth/scopes";
import { RoleEnum } from "./common";

export const CreateWorkspaceSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(100)
		.meta({ description: "Human-readable display name for the workspace" }),
	slug: z
		.string()
		.min(2)
		.max(50)
		.regex(/^[a-z0-9-]+$/)
		.meta({ description: 'URL-safe identifier for the workspace (e.g. "my-team")' }),
});

export const UpdateWorkspaceSchema = z.object({
	name: z.string().min(1).max(100).meta({ description: "New display name for the workspace" }),
});

export const InviteMemberSchema = z.object({
	email: z.string().email().meta({ description: "Email address of the user to invite" }),
	role: RoleEnum.default("member").meta({ description: "Role to assign to the invited user" }),
});

export const UpdateRoleSchema = z.object({
	role: RoleEnum.meta({ description: "New role to assign" }),
});

export const CreateTokenSchema = z.object({
	name: z.string().min(1).max(100),
	scopes: z.array(ScopeSchema).min(1).default(["read", "write"]),
	expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const DeleteWorkspaceInput = z.object({
	workspaceSlug: z.string().meta({ description: "Slug of the workspace to delete" }),
});

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const UpdateWorkspaceBrandSchema = z
	.object({
		displayName: z
			.string()
			.min(1)
			.max(100)
			.nullable()
			.optional()
			.meta({ description: "Workspace display name override" }),
		accent: HexColor.nullable()
			.optional()
			.meta({ description: "Accent color as a hex string, e.g. #ff8800" }),
		onAccent: HexColor.nullable().optional().meta({
			description: "Text/icon color to use on top of the accent color, as a hex string",
		}),
		fontFamily: z
			.string()
			.min(1)
			.max(100)
			.nullable()
			.optional()
			.meta({ description: "CSS font-family override" }),
		fontUrl: z
			.string()
			.url()
			.refine((v) => v.startsWith("https://"), "fontUrl must be an https:// URL")
			.nullable()
			.optional()
			.meta({ description: "URL of a stylesheet defining fontFamily" }),
	})
	.strict();
