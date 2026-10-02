import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import { createLink, deleteLink, listLinksForIssue } from "../services/issue-links";
import { CREATE, DESTRUCTIVE, READ } from "./annotations";

export const issueLinksTools: MCPTool[] = [
	{
		name: "create_issue_link",
		description:
			"Create a typed link between two issues (blocks, blocked_by, relates_to, duplicates, follows_from). " +
			"follows_from: the source is a follow-up that continues the target (list_issue_links reports the inverse as followed_by)",
		inputSchema: {
			type: "object",
			required: ["sourceIssueId", "targetIssueId", "type"],
			properties: {
				sourceIssueId: {
					type: "string",
					description: "UUID of the source issue, or a ref like PROJ-42",
				},
				targetIssueId: {
					type: "string",
					description: "UUID of the target issue, or a ref like PROJ-42",
				},
				type: {
					type: "string",
					enum: ["blocks", "blocked_by", "relates_to", "duplicates", "follows_from"],
					description: "Relationship type from the source issue's perspective",
				},
			},
		},
		annotations: CREATE,
		handler(input, ctx) {
			return createLink(ctx, input);
		},
	},
	{
		name: "delete_issue_link",
		description: "Delete an issue link by ID",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "UUID of the link to delete" },
			},
		},
		annotations: DESTRUCTIVE,
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return deleteLink(ctx, { id });
		},
	},
	{
		name: "list_issue_links",
		description: "List all links for an issue (shows effective type from this issue's perspective)",
		inputSchema: {
			type: "object",
			required: ["issueId"],
			properties: {
				issueId: { type: "string", description: "UUID of the issue, or a ref like PROJ-42" },
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return listLinksForIssue(ctx, input);
		},
	},
];
