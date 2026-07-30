import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import type { ServiceCtx } from "../services/types";
import * as wikiService from "../services/wiki";

export const wikiTools: MCPTool[] = [
	{
		name: "list_wiki_pages",
		description: "List wiki pages in the workspace, optionally filtered by parent or project",
		inputSchema: {
			type: "object",
			properties: {
				parentId: { type: "string", description: "Filter to children of this page ID" },
				projectId: { type: "string", description: "Filter to pages belonging to this project ID" },
			},
		},
		async handler(input, ctx) {
			return wikiService.listWikiPages(ctx, input);
		},
	},
	{
		name: "search_wiki",
		description: "Search wiki pages by keyword in title or content",
		inputSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: { type: "string" },
				limit: { type: "number", default: 10 },
				projectId: { type: "string", description: "Restrict search to this project ID" },
			},
		},
		async handler(input, ctx) {
			return wikiService.searchWiki(ctx, input);
		},
	},
	{
		name: "get_wiki_page",
		description: "Get a wiki page by slug, including full content",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: { slug: { type: "string" } },
		},
		async handler(input, ctx) {
			const { slug } = input as { slug: string };
			return wikiService.getWikiPage(ctx, slug);
		},
	},
	{
		name: "create_wiki_page",
		description: "Create a new wiki page",
		inputSchema: {
			type: "object",
			required: ["title"],
			properties: {
				title: { type: "string" },
				slug: {
					type: "string",
					description: "URL-safe identifier; auto-generated from title if omitted",
				},
				content: { type: "string", description: "Markdown content" },
				parentId: { type: "string", description: "Parent page ID for nested pages" },
				projectId: { type: "string", description: "Project ID to scope this page to" },
			},
		},
		async handler(input, ctx) {
			return wikiService.createWikiPage(ctx, input);
		},
	},
	{
		name: "update_wiki_page",
		description:
			"Update a wiki page by id or slug (saves a revision when content changes). Pass " +
			"baseRevisionId (the current revision id from list_wiki_revisions/get_wiki_revision, " +
			"or null if the page has never been revised) for conflict-safe writes: if the page " +
			"advanced since baseRevisionId, the write is rejected with a structured conflict " +
			"(currentRevisionId + a unified diff) instead of silently overwriting. Omitting " +
			"baseRevisionId is DEPRECATED — it keeps today's last-write-wins behavior during the " +
			"transition and will be rejected in a future version.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Page ID" },
				slug: { type: "string", description: "Page slug (alternative to id)" },
				title: { type: "string" },
				content: { type: "string" },
				parentId: {
					type: "string",
					nullable: true,
					description: "Parent page ID (null to unset parent, omit to leave unchanged)",
				},
				newSlug: {
					type: "string",
					description:
						"Rename the page's slug; the old slug becomes a redirect so existing links keep resolving",
				},
				baseRevisionId: {
					type: ["string", "null"],
					description:
						"Deprecated if omitted (see tool description). The revision id this edit is " +
						"based on — null if the page has never been revised.",
				},
				summary: {
					type: "string",
					description: "Optional edit message/changelog note, recorded on the created revision",
				},
			},
		},
		async handler(input, ctx) {
			const { id, slug, newSlug, ...rest } = input as {
				id?: string;
				slug?: string;
				newSlug?: string;
				title?: string;
				content?: string;
				parentId?: string | null;
				baseRevisionId?: string | null;
				summary?: string;
			};
			const idOrSlug = id ?? slug;
			if (!idOrSlug) {
				throw new ValidationError({
					formErrors: ["Either id or slug must be provided"],
					fieldErrors: {},
				});
			}
			const payload = newSlug !== undefined ? { ...rest, slug: newSlug } : rest;
			return wikiService.updateWikiPage(ctx, idOrSlug, payload);
		},
	},
	{
		name: "delete_wiki_page",
		description:
			"Delete a wiki page by slug (not allowed for viewers). By default any child pages are " +
			"promoted to the deleted page's parent; pass cascade=true to delete the whole subtree instead.",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: {
				slug: { type: "string" },
				cascade: {
					type: "boolean",
					default: false,
					description: "Delete all descendant pages too, instead of promoting them",
				},
			},
		},
		async handler(input, ctx) {
			const { slug, cascade } = input as { slug: string; cascade?: boolean };
			return wikiService.deleteWikiPage(ctx as ServiceCtx, slug, { cascade });
		},
	},
	{
		name: "wiki_tree",
		description: "Get the wiki page hierarchy as a nested tree, optionally filtered by project",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "Filter to pages belonging to this project ID" },
			},
		},
		async handler(input, ctx) {
			const { projectId } = input as { projectId?: string };
			return wikiService.getWikiTree(ctx as ServiceCtx, projectId);
		},
	},
	{
		name: "list_wiki_revisions",
		description: "List revision history for a wiki page",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: { slug: { type: "string" } },
		},
		async handler(input, ctx) {
			const { slug } = input as { slug: string };
			return wikiService.listWikiRevisions(ctx as ServiceCtx, slug);
		},
	},
	{
		name: "get_wiki_revision",
		description: "Get the content of a specific wiki revision by its ID",
		inputSchema: {
			type: "object",
			required: ["slug", "revisionId"],
			properties: {
				slug: { type: "string" },
				revisionId: { type: "string" },
			},
		},
		async handler(input, ctx) {
			const { slug, revisionId } = input as { slug: string; revisionId: string };
			return wikiService.getWikiRevision(ctx as ServiceCtx, slug, revisionId);
		},
	},
];
