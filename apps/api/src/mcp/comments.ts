import type { MCPTool } from "@projektor/types";
import { addComment, deleteComment, listComments, updateComment } from "../services/comments";
import { ValidationError } from "../services/errors";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, PLAIN_WRITE, READ } from "./annotations";
import { capPage, toPage } from "./serialize";
import { bodyPreview } from "./windowing";

const DEFAULT_COMMENT_PAGE = 50;
const MAX_COMMENT_PAGE = 100;

function intArg(name: string, v: unknown, min: number, max: number): number {
	if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: { [name]: [`must be an integer from ${min} to ${max}`] },
		});
	}
	return v as number;
}

function offsetArg(cursor: unknown, total: number): number {
	const n = Number(cursor);
	if (typeof cursor !== "string" || !Number.isInteger(n) || n < 0 || n > total) {
		throw new ValidationError({ formErrors: [], fieldErrors: { cursor: ["invalid cursor"] } });
	}
	return n;
}

// PROJ-959: every comment tool resolves a ref the same way get_issue does.
const ISSUE_ID_PROP = { type: "string", description: "UUID of the issue, or a ref like PROJ-42" };
const ID_ALIAS_PROP = { type: "string", description: "Alias of issueId" };

export const commentsTools: MCPTool[] = [
	{
		name: "list_comments",
		description:
			"List comments on an issue (UUID or ref like PROJ-42), oldest first. Paged: `limit` " +
			"(default 50) with `next`/`total`; `latest:N` returns just the newest N. Each item is " +
			"{id, author, created, body, edited?}; bodyChars:N previews long bodies; verbose:true " +
			"returns the raw rows. See /projektor/agents/response-conventions/.",
		inputSchema: {
			type: "object",
			required: ["issueId"],
			properties: {
				issueId: ISSUE_ID_PROP,
				id: ID_ALIAS_PROP,
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_COMMENT_PAGE,
					default: DEFAULT_COMMENT_PAGE,
					description: `Max comments per page (1-${MAX_COMMENT_PAGE}, default ${DEFAULT_COMMENT_PAGE})`,
				},
				cursor: {
					type: "string",
					description: "Pass the previous page's `next` unchanged",
				},
				latest: {
					type: "integer",
					minimum: 1,
					maximum: MAX_COMMENT_PAGE,
					description:
						"Return only the newest N comments (still oldest-first); ignores limit and cursor",
				},
				bodyChars: {
					type: "integer",
					minimum: 1,
					maximum: 10_000,
					description:
						"Cut each body to its first N characters (a cut body carries bodyTruncated:true)",
				},
				verbose: {
					type: "boolean",
					description: "Raw rows (author_id, author_email, updated_at) with no paging",
				},
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			// PROJ-1053: paging and the slim shape are MCP-only presentation; REST still
			// returns every row (the issue page renders the whole thread).
			const { limit, cursor, latest, bodyChars, verbose, ...rest } = (input ?? {}) as Record<
				string,
				unknown
			>;
			const rows = await listComments(ctx, rest);
			if (verbose === true) return toPage(rows);

			const total = rows.length;
			let start: number;
			let end: number;
			if (latest !== undefined) {
				start = Math.max(0, total - intArg("latest", latest, 1, MAX_COMMENT_PAGE));
				end = total;
			} else {
				start = cursor === undefined ? 0 : offsetArg(cursor, total);
				end = Math.min(
					total,
					start + intArg("limit", limit ?? DEFAULT_COMMENT_PAGE, 1, MAX_COMMENT_PAGE)
				);
			}
			const chars = bodyChars === undefined ? undefined : intArg("bodyChars", bodyChars, 1, 10_000);
			const items = rows.slice(start, end).map((r) => ({
				id: r.id,
				author: r.author_name,
				created: r.created_at,
				...(chars === undefined ? { body: r.body } : bodyPreview(r.body, chars)),
				...(r.updated_at !== r.created_at ? { edited: true } : {}),
			}));
			const page = toPage(items, latest === undefined && end < total ? end : null, { total });
			return capPage(page, { cursorOf: (i) => String(start + i + 1) });
		},
	},
	{
		name: "add_comment",
		description: "Add a comment to an issue (UUID or ref like PROJ-42)",
		inputSchema: {
			type: "object",
			required: ["issueId", "body"],
			properties: {
				issueId: ISSUE_ID_PROP,
				id: ID_ALIAS_PROP,
				body: { type: "string", minLength: 1, maxLength: 10000 },
			},
		},
		annotations: PLAIN_WRITE,
		async handler(input, ctx) {
			return addComment(ctx, input);
		},
	},
	{
		name: "update_comment",
		description: "Update the body of a comment (author only)",
		inputSchema: {
			type: "object",
			required: ["issueId", "commentId", "body"],
			properties: {
				issueId: ISSUE_ID_PROP,
				id: ID_ALIAS_PROP,
				commentId: { type: "string" },
				body: { type: "string", minLength: 1, maxLength: 10000 },
			},
		},
		annotations: IDEMPOTENT_WRITE,
		async handler(input, ctx) {
			return updateComment(ctx, input);
		},
	},
	{
		name: "delete_comment",
		description: "Delete a comment (author, admin, or owner)",
		inputSchema: {
			type: "object",
			required: ["issueId", "commentId"],
			properties: {
				issueId: ISSUE_ID_PROP,
				id: ID_ALIAS_PROP,
				commentId: { type: "string" },
			},
		},
		annotations: DESTRUCTIVE,
		async handler(input, ctx) {
			return deleteComment(ctx, input);
		},
	},
];
