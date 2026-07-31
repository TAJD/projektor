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
		description:
			"Full-text search over wiki pages (FTS5, BM25-ranked, title weighted above body). " +
			"Returns match-anchored snippets highlighted with ** markers. type/tags/status are " +
			"accepted for forward compatibility with the frontmatter (R6) and freshness (R7) " +
			"work but are not yet implemented and are ignored if passed.",
		inputSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: { type: "string" },
				limit: { type: "number", default: 10 },
				offset: { type: "number", default: 0 },
				projectId: { type: "string", description: "Restrict search to this project ID" },
				updatedSince: {
					type: "number",
					description: "Unix seconds — only return pages updated at or after this time",
				},
				type: { type: "string", description: "Not yet supported (R6, PROJ-488); ignored" },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Not yet supported (R6, PROJ-488); ignored",
				},
				status: { type: "string", description: "Not yet supported (R7, PROJ-489); ignored" },
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
		name: "get_backlinks",
		description:
			"List pages that link to the given page via a resolved [[wikilink]] or same-workspace " +
			"URL (id-backed, so renames never break a backlink). Each result includes a snippet of " +
			"the citing text when it can still be located in the source page's current content.",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: {
				slug: { type: "string", description: "Page ID or slug to find backlinks for" },
			},
		},
		async handler(input, ctx) {
			const { slug } = input as { slug: string };
			return wikiService.getWikiBacklinks(ctx as ServiceCtx, slug);
		},
	},
	{
		name: "list_broken_wiki_links",
		description:
			"List unresolved wiki links in the workspace — [[Target]]/URL links whose target " +
			"title or slug didn't match any page at write time. Useful as a maintenance queue.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "Restrict to links from pages in this project" },
			},
		},
		async handler(input, ctx) {
			return wikiService.listBrokenWikiLinks(ctx, input);
		},
	},
	{
		name: "backfill_wiki_links",
		description:
			"One-time (idempotent, safe to re-run) recompute of the wiki_links graph for every " +
			"existing page in the workspace. Owner/admin only.",
		inputSchema: { type: "object", properties: {} },
		async handler(_input, ctx) {
			return wikiService.backfillWikiLinks(ctx as ServiceCtx);
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
