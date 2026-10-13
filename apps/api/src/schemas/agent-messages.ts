import { z } from "zod";
import { ISSUE_REF_PATTERN } from "./common";

const UUID_PATTERN = /^[0-9a-f-]{36}$/;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]*$/;

const isIssueTarget = (v: string) => UUID_PATTERN.test(v) || ISSUE_REF_PATTERN.test(v);
const isProjectTarget = (v: string) => UUID_PATTERN.test(v) || PROJECT_KEY_PATTERN.test(v);

// PROJ-959: an issue channel may be addressed by UUID or by ref ("issue:PROJ-42"); the
// service canonicalises it to the UUID form so both spellings name the same channel.
const scopeSchema = z
	.string()
	.refine(
		(v) =>
			v === "workspace" ||
			v === "project" ||
			isIssueTarget(v) ||
			(v.startsWith("issue:") && isIssueTarget(v.slice("issue:".length))) ||
			(v.startsWith("project:") && isProjectTarget(v.slice("project:".length))),
		{
			message:
				'scope must be "workspace", "issue:<uuid|ref like PROJ-42>" (or the bare uuid/ref), "project:<key|uuid>", or "project" with projectId',
		}
	);

const channelFields = {
	scope: scopeSchema.optional(),
	projectId: z
		.string()
		.refine(isProjectTarget, { message: "projectId must be a project UUID or key like PROJ" })
		.optional(),
};

function checkProjectId(data: { scope?: string; projectId?: string }, ctx: z.RefinementCtx): void {
	if (data.scope === "project" && data.projectId === undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'projectId is required when scope is "project"',
			path: ["projectId"],
		});
	} else if (data.projectId !== undefined && data.scope !== undefined && data.scope !== "project") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'projectId only applies when scope is "project" or omitted',
			path: ["projectId"],
		});
	}
}

export const PostMessageSchema = z
	.object({
		...channelFields,
		agentId: z.string().uuid().optional(),
		body: z.string().min(1).max(5000),
	})
	.superRefine(checkProjectId);

export const ListMessagesSchema = z
	.object({
		...channelFields,
		// Opaque composite cursor: "createdAt:id" — stable across same-second inserts
		cursor: z.string().optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		order: z.enum(["asc", "desc"]).default("asc"),
		since: z.coerce.number().int().nonnegative().optional(),
	})
	.superRefine(checkProjectId);
