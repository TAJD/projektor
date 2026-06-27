import type { MCPTool } from "@projektor/types";
import { addComment, deleteComment, listComments, updateComment } from "../services/comments";
import type { ServiceCtx } from "../services/types";

export const commentsTools: MCPTool[] = [
	{
		name: "list_comments",
		description: "List comments on an issue",
		inputSchema: {
			type: "object",
			required: ["issueId"],
			properties: { issueId: { type: "string" } },
		},
		async handler(input, ctx) {
			return listComments(ctx as unknown as ServiceCtx, input);
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
		async handler(input, ctx) {
			return addComment(ctx as unknown as ServiceCtx, input);
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
		async handler(input, ctx) {
			return updateComment(ctx as unknown as ServiceCtx, input);
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
		async handler(input, ctx) {
			return deleteComment(ctx as unknown as ServiceCtx, input);
		},
	},
];
