import {
	CreateIssueLinkSchema,
	CreateIssueLinksSchema,
	DeleteIssueLinkFields,
	ListIssueLinksSchema,
} from "../schemas/issues";
import { createLink, createLinks, deleteLink, listLinksForIssue } from "../services/issue-links";
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
		minRole: "member",
		status: 201,
		summary:
			"Create a typed link between two issues (blocks, blocked_by, relates_to, duplicates, follows_from). " +
			"follows_from: the source is a follow-up that continues the target (list_issue_links reports the inverse as followed_by)",
		input: CreateIssueLinkSchema,
		run: (ctx, input) => createLink(ctx, input),
	}),
	defineOperation({
		...base,
		id: "create_issue_links",
		method: "POST",
		path: "/api/issues/links/bulk",
		tier: "write",
		minRole: "member",
		summary:
			"Create up to 100 issue links in one call, e.g. fanning one epic out to many children. " +
			"Each link is {source, target, type} with the same types as create_issue_link. Returns `results` " +
			"in input order: {id} for a created link, or {error: {code, message}} for one that was rejected " +
			"(unknown issue, no write access, self-link, already exists, or repeated in this call). " +
			"A rejected link doesn't stop the others.",
		input: CreateIssueLinksSchema,
		run: (ctx, input) => createLinks(ctx, input),
	}),
	defineOperation({
		...base,
		id: "delete_issue_link",
		method: "DELETE",
		path: "/api/issues/:issueId/links/:id",
		tier: "destructive",
		minRole: "member",
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
