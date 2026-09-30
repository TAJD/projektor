import type { MCPTool } from "@projektor/types";
import { addComment, deleteComment, listComments, updateComment } from "../services/comments";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, PLAIN_WRITE, READ } from "./annotations";
import { toPage } from "./serialize";

export const commentsTools: MCPTool[] = [
	{
		name: "list_comments",
		description:
			"List comments on an issue. Returns `{items}` (see /projektor/agents/response-conventions/).",
		inputSchema: {
			type: "object",
			required: ["issueId"],
			properties: { issueId: { type: "string" } },
		},
		annotations: READ,
		async handler(input, ctx) {
			return toPage(await listComments(ctx, input));
		},
	},
	{
		name: "add_comment",
		description: "Add a comment to an issue",
		inputSchema: {
			type: "object",
			required: ["issueId", "body"],
			properties: {
				issueId: { type: "string" },
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
				issueId: { type: "string" },
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
				issueId: { type: "string" },
				commentId: { type: "string" },
			},
		},
		annotations: DESTRUCTIVE,
		async handler(input, ctx) {
			return deleteComment(ctx, input);
		},
	},
];
