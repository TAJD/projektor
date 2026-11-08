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
	scope: scopeSchema.optional().meta({
		description:
			'Channel scope: "workspace" (default), "issue:<uuid>" / "issue:<ref like PROJ-42>" (or just the bare uuid/ref), "project:<key|uuid>", or "project" together with projectId. Every spelling of a channel names the same channel',
	}),
	projectId: z
		.string()
		.refine(isProjectTarget, { message: "projectId must be a project UUID or key like PROJ" })
		.optional()
		.meta({
			description:
				'Project key (e.g. PROJ) or UUID. Use with scope "project"; on its own it selects that project\'s channel',
		}),
};

type Channel = { scope?: string; projectId?: string };

const projectIdGiven = (data: Channel) =>
	!(data.scope === "project" && data.projectId === undefined);
const PROJECT_ID_REQUIRED = {
	message: 'projectId is required when scope is "project"',
	path: ["projectId"],
};
const projectIdApplies = (data: Channel) =>
	data.projectId === undefined || data.scope === undefined || data.scope === "project";
const PROJECT_ID_ONLY_FOR_PROJECT = {
	message: 'projectId only applies when scope is "project" or omitted',
	path: ["projectId"],
};

export const PostMessageSchema = z
	.object({
		...channelFields,
		agentId: z
			.string()
			.uuid()
			.optional()
			.meta({ description: "Agent session UUID posting the message (optional)" }),
		body: z.string().min(1).max(5000).meta({ description: "Message body (1–5000 characters)" }),
	})
	.refine(projectIdGiven, PROJECT_ID_REQUIRED)
	.refine(projectIdApplies, PROJECT_ID_ONLY_FOR_PROJECT);

export const ListMessagesSchema = z
	.object({
		...channelFields,
		// Opaque composite cursor: "createdAt:id" — stable across same-second inserts
		cursor: z
			.string()
			.optional()
			.meta({ description: "Pagination cursor: pass the previous page's `nextCursor` unchanged" }),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(100)
			.default(50)
			.meta({ description: "Max messages to return (1–100)" }),
		order: z
			.enum(["asc", "desc"])
			.default("asc")
			.meta({ description: "desc = newest first, asc = oldest first" }),
		since: z.coerce.number().int().nonnegative().optional().meta({
			description:
				"Unix seconds: only messages created at or after this time (rows' createdAt is in milliseconds)",
		}),
	})
	.refine(projectIdGiven, PROJECT_ID_REQUIRED)
	.refine(projectIdApplies, PROJECT_ID_ONLY_FOR_PROJECT);
