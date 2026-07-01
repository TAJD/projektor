import { z } from "zod";

const scopeSchema = z.string().refine((v) => v === "workspace" || /^issue:[0-9a-f-]{36}$/.test(v), {
	message: 'scope must be "workspace" or "issue:<uuid>"',
});

export const PostMessageSchema = z.object({
	scope: scopeSchema,
	agentId: z.string().uuid().optional(),
	body: z.string().min(1).max(5000),
});

export const ListMessagesSchema = z.object({
	scope: scopeSchema,
	// Opaque composite cursor: "createdAt:id" — stable across same-second inserts
	cursor: z.string().optional(),
	limit: z.coerce.number().min(1).max(100).default(50),
});
