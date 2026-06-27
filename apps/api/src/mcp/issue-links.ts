import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import { createLink, deleteLink, listLinksForIssue } from "../services/issue-links";

export const issueLinksTools: MCPTool[] = [
	{
		name: "create_issue_link",
		description:
			"Create a typed link between two issues (blocks, blocked_by, relates_to, duplicates)",
		inputSchema: {
			type: "object",
			required: ["sourceIssueId", "targetIssueId", "type"],
			properties: {
				sourceIssueId: { type: "string", description: "UUID of the source issue" },
				targetIssueId: { type: "string", description: "UUID of the target issue" },
				type: {
					type: "string",
					enum: ["blocks", "blocked_by", "relates_to", "duplicates"],
					description: "Relationship type from the source issue's perspective",
				},
			},
		},
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
				issueId: { type: "string", description: "UUID of the issue" },
			},
		},
		handler(input, ctx) {
			return listLinksForIssue(ctx, input);
		},
	},
];
