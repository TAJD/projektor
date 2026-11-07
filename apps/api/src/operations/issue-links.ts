import {
	CreateIssueLinkSchema,
	DeleteIssueLinkFields,
	ListIssueLinksSchema,
} from "../schemas/issues";
import { createLink, deleteLink, listLinksForIssue } from "../services/issue-links";
import { defineOperation } from "./define";

const base = {
	domain: "issue-links",
	keywords: ["dependencies", "blocks", "blocked by", "relates", "duplicates", "follow-up"],
};

export const issueLinkOperations = [
	defineOperation({
		...base,
		id: "create_issue_link",
		method: "POST",
		path: "/api/issues/:sourceIssueId/links",
		tier: "write",
		status: 201,
		summary:
			"Create a typed link between two issues (blocks, blocked_by, relates_to, duplicates, follows_from). " +
			"follows_from: the source is a follow-up that continues the target (list_issue_links reports the inverse as followed_by)",
		input: CreateIssueLinkSchema,
		run: (ctx, input) => createLink(ctx, input),
	}),
	defineOperation({
		...base,
		id: "delete_issue_link",
		method: "DELETE",
		path: "/api/issues/:issueId/links/:id",
		tier: "destructive",
		summary: "Delete an issue link by ID",
		input: DeleteIssueLinkFields,
		run: (ctx, { id }) => deleteLink(ctx, { id }),
	}),
	defineOperation({
		...base,
		id: "list_issue_links",
		method: "GET",
		path: "/api/issues/:issueId/links",
		tier: "read",
		summary: "List all links for an issue (shows effective type from this issue's perspective)",
		input: ListIssueLinksSchema,
		run: (ctx, input) => listLinksForIssue(ctx, input),
	}),
];
