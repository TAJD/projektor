import { z } from "zod";
import { ISSUE_REF_PATTERN } from "./common";

// PROJ-959: an issue channel may be addressed by UUID or by ref ("issue:PROJ-42"); the
// service canonicalises it to the UUID form so both spellings name the same channel.
const scopeSchema = z
	.string()
	.refine(
		(v) =>
			v === "workspace" ||
			/^issue:[0-9a-f-]{36}$/.test(v) ||
			(v.startsWith("issue:") && ISSUE_REF_PATTERN.test(v.slice("issue:".length))),
		{
			message: 'scope must be "workspace", "issue:<uuid>" or "issue:<ref like PROJ-42>"',
		}
	);

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
