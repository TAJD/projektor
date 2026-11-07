import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import { capPage, toPage } from "../mcp/serialize";
import { bodyPreview } from "../mcp/windowing";
import {
	AddCommentSchema,
	DeleteCommentSchema,
	ListCommentsSchema,
	UpdateCommentSchema,
} from "../schemas/comments";
import { addComment, deleteComment, listComments, updateComment } from "../services/comments";
import { ValidationError } from "../services/errors";
import { defineOperation } from "./define";

const DEFAULT_COMMENT_PAGE = 50;
const MAX_COMMENT_PAGE = 100;

const base = {
	domain: "comments",
	keywords: ["discussion", "note", "reply", "thread", "remark", "feedback"],
};

function offsetArg(cursor: string, total: number): number {
	const n = Number(cursor);
	if (!Number.isInteger(n) || n < 0 || n > total) {
		throw new ValidationError({ formErrors: [], fieldErrors: { cursor: ["invalid cursor"] } });
	}
	return n;
}

export const commentOperations = [
	defineOperation({
		...base,
		id: "list_comments",
		method: "GET",
		path: "/api/issues/:issueId/comments",
		tier: "read",
		summary:
			"List comments on an issue (UUID or ref like PROJ-42), oldest first. Paged: `limit` " +
			"(default 50) with `next`/`total`; `latest:N` returns just the newest N. Each item is " +
			"{id, author, created, body, edited?}; bodyChars:N previews long bodies; verbose:true " +
			"returns the raw rows. See /projektor/agents/response-conventions/.",
		input: ListCommentsSchema.extend({
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_COMMENT_PAGE)
				.default(DEFAULT_COMMENT_PAGE)
				.meta({
					description: `Max comments per page (1-${MAX_COMMENT_PAGE}, default ${DEFAULT_COMMENT_PAGE})`,
				}),
			cursor: z
				.string()
				.optional()
				.meta({ description: "Pass the previous page's `next` unchanged" }),
			latest: z.number().int().min(1).max(MAX_COMMENT_PAGE).optional().meta({
				description:
					"Return only the newest N comments (still oldest-first); ignores limit and cursor",
			}),
			bodyChars: z.number().int().min(1).max(10_000).optional().meta({
				description:
					"Cut each body to its first N characters (a cut body carries bodyTruncated:true)",
			}),
			verbose: z
				.boolean()
				.optional()
				.meta({ description: "Raw rows (author_id, author_email, updated_at) with no paging" }),
		}),
		run: (ctx, { issueId }) => listComments(ctx, { issueId }),
		mcpResult: (result, { limit, cursor, latest, bodyChars, verbose }) => {
			const rows = result as Awaited<ReturnType<typeof listComments>>;
			if (verbose) return toPage(rows);
			const total = rows.length;
			let start: number;
			let end: number;
			if (latest !== undefined) {
				start = Math.max(0, total - latest);
				end = total;
			} else {
				start = cursor === undefined ? 0 : offsetArg(cursor, total);
				end = Math.min(total, start + limit);
			}
			const items = rows.slice(start, end).map((r) => ({
				id: r.id,
				author: r.author_name,
				created: r.created_at,
				...(bodyChars === undefined ? { body: r.body } : bodyPreview(r.body, bodyChars)),
				...(r.updated_at !== r.created_at ? { edited: true } : {}),
			}));
			const page = toPage(items, latest === undefined && end < total ? end : null, { total });
			return capPage(page, { cursorOf: (i) => String(start + i + 1) });
		},
	}),
	defineOperation({
		...base,
		id: "add_comment",
		method: "POST",
		path: "/api/issues/:issueId/comments",
		tier: "write",
		annotations: PLAIN_WRITE,
		status: 201,
		summary: "Add a comment to an issue (UUID or ref like PROJ-42)",
		input: AddCommentSchema,
		run: (ctx, input) => addComment(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_comment",
		method: "PATCH",
		path: "/api/issues/:issueId/comments/:commentId",
		tier: "write",
		summary: "Update the body of a comment (author only)",
		input: UpdateCommentSchema,
		run: (ctx, input) => updateComment(ctx, input),
	}),
	defineOperation({
		...base,
		id: "delete_comment",
		method: "DELETE",
		path: "/api/issues/:issueId/comments/:commentId",
		tier: "destructive",
		summary: "Delete a comment (author, admin, or owner)",
		input: DeleteCommentSchema,
		run: (ctx, input) => deleteComment(ctx, input),
	}),
];
