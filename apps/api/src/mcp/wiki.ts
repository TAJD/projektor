import type { MCPTool } from "@projektor/types";
import { WIKI_WELL_KNOWN_TYPES } from "../schemas/wiki";
import { ValidationError } from "../services/errors";
import type { ServiceCtx } from "../services/types";
import * as wikiService from "../services/wiki";

// PROJ-513: `type` is freeform — these are advertised as hints, never as an
// inputSchema `enum` (which clients treat as the only legal values).
const WELL_KNOWN_TYPES = WIKI_WELL_KNOWN_TYPES.join("|");
const TYPE_FILTER_DESCRIPTION =
	"Filter to pages whose frontmatter `type` matches (freeform; well-known " +
	`values are ${WELL_KNOWN_TYPES})`;

export const wikiTools: MCPTool[] = [
	{
		name: "list_wiki_pages",
		description:
			"List wiki pages in the workspace, optionally filtered by parent, project, " +
			"frontmatter type/status, or tags (any-of match)",
		inputSchema: {
			type: "object",
			properties: {
				parentId: { type: "string", description: "Filter to children of this page ID" },
				projectId: { type: "string", description: "Filter to pages belonging to this project ID" },
				type: {
					type: "string",
					description: TYPE_FILTER_DESCRIPTION,
				},
				status: {
					type: "string",
					enum: ["draft", "current", "stale", "deprecated"],
					description: "Filter to pages whose frontmatter `status` matches",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Filter to pages carrying at least one of these frontmatter tags",
				},
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
			"Returns match-anchored snippets highlighted with ** markers, plus a computed " +
			"`freshness` ({state, staleSince} or null if the page has no verify_interval/status " +
			"signal) per result. type/status/tags filter on the denormalized frontmatter columns " +
			"(R6). Results are demoted (ranked below everything else, ties broken by bm25 within " +
			"each tier) when the page is computed-stale/unverified OR has an explicit " +
			"status: stale|deprecated (R7).",
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
				type: {
					type: "string",
					description: TYPE_FILTER_DESCRIPTION,
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Filter to pages carrying at least one of these frontmatter tags",
				},
				status: {
					type: "string",
					enum: ["draft", "current", "stale", "deprecated"],
					description: "Filter to pages whose frontmatter `status` matches",
				},
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
		description:
			"Create a new wiki page. `content` may start with an optional YAML frontmatter block " +
			"(`---\\ntype: runbook\\ntags: [foo]\\nstatus: draft\\n---\\n...`) — type (freeform; " +
			`well-known values ${WELL_KNOWN_TYPES}), tags[], status (draft|current|stale|` +
			"deprecated), verified_at, verified_by, owners[], verify_interval (days), template " +
			"(boolean) are parsed and denormalized for filtering. Invalid frontmatter (bad " +
			"status/enum value, wrong field type, unrecognized key) is rejected with a structured " +
			"validation error, not silently ignored. Alternatively, pass `templateSlug` (from " +
			"list_wiki_templates) to seed this page's content from an existing template page — " +
			"its `template: true` flag is stripped from the seeded content (the new page is not " +
			"itself a template). `templateSlug` and `content` are mutually exclusive; a " +
			"`templateSlug` that doesn't resolve to a page flagged template:true is rejected.",
		inputSchema: {
			type: "object",
			required: ["title"],
			properties: {
				title: { type: "string" },
				slug: {
					type: "string",
					description: "URL-safe identifier; auto-generated from title if omitted",
				},
				content: {
					type: "string",
					description:
						"Markdown content, optionally starting with a YAML frontmatter block. " +
						"Mutually exclusive with templateSlug.",
				},
				templateSlug: {
					type: "string",
					description:
						"Seed this page's content from the template page at this slug/id (see " +
						"list_wiki_templates). Mutually exclusive with content.",
				},
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
			"transition and will be rejected in a future version. `content` may include a YAML " +
			"frontmatter block (see create_wiki_page); it's re-parsed on every content edit, " +
			"replacing the page's previously-stored metadata. Omitting `content` leaves the " +
			"page's existing frontmatter metadata unchanged.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Page ID" },
				slug: { type: "string", description: "Page slug (alternative to id)" },
				title: { type: "string" },
				content: {
					type: "string",
					description: "Markdown content, optionally starting with a YAML frontmatter block",
				},
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
		name: "patch_wiki_page",
		description:
			"Section-addressed patch operations on a wiki page's markdown, by id or slug. " +
			"Sections are addressed by exact heading text (a `#`..`######` line and everything " +
			"up to the next heading; `#` lines inside fenced code blocks or the YAML " +
			"frontmatter block are not headings). A heading that appears more than once on " +
			"the page is ambiguous and rejected — patch targets must be unique. " +
			"Ops: append_to_section (add text at the end of the " +
			"section's body), replace_section (replace the section's body, heading kept), " +
			"insert_after_heading (insert text directly under the heading, before the " +
			"existing body), append_to_page (append at the very end of the document, no " +
			"heading needed). baseRevisionId is required (the current revision id from " +
			"list_wiki_revisions/get_wiki_revision, or null if the page has never been " +
			"revised) — conflict detection is SECTION-scoped, not whole-page: two agents " +
			"patching two different sections never conflict with each other even if the " +
			"page's overall revision advanced between their reads, only if the SAME section " +
			"changed underneath the caller. On a heading miss (never existed, or was " +
			"deleted/renamed since baseRevisionId) the error lists the page's current " +
			"headings so a caller can retry against reality. Creates a revision, same as " +
			"update_wiki_page; does not touch the page's existing frontmatter metadata beyond " +
			"reparsing it (never stamps verified_at).",
		inputSchema: {
			type: "object",
			required: ["op", "baseRevisionId"],
			properties: {
				id: { type: "string", description: "Page ID" },
				slug: { type: "string", description: "Page slug (alternative to id)" },
				op: {
					type: "string",
					enum: ["append_to_section", "replace_section", "insert_after_heading", "append_to_page"],
				},
				heading: {
					type: "string",
					description:
						"Target section's heading text (required for every op except append_to_page)",
				},
				text: { type: "string", description: "Text to add/replace" },
				baseRevisionId: {
					type: ["string", "null"],
					description:
						"The revision id this patch is based on — null if the page has never been revised.",
				},
				summary: {
					type: "string",
					description: "Optional edit message/changelog note, recorded on the created revision",
				},
			},
		},
		async handler(input, ctx) {
			const { id, slug, ...rest } = input as { id?: string; slug?: string };
			const idOrSlug = id ?? slug;
			if (!idOrSlug) {
				throw new ValidationError({
					formErrors: ["Either id or slug must be provided"],
					fieldErrors: {},
				});
			}
			return wikiService.patchWikiPage(ctx as ServiceCtx, idOrSlug, rest);
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
			"title or slug didn't match any page at write time. Useful as a maintenance queue. " +
			"Note: a broken link does not auto-re-resolve if the missing page is created later — " +
			"only backfill_wiki_links (or re-saving the linking page) re-resolves it.",
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
	{
		name: "verify_wiki_page",
		description:
			"Stamp a wiki page as freshly verified — sets its frontmatter verified_at to now and " +
			"verified_by to the CALLING user's email (never caller-supplied). Rewrites the page's " +
			"frontmatter block (creating one if it had none) and records a revision, same as any " +
			"other content edit — including its conflict check, so a concurrent edit racing the " +
			"stamp is rejected rather than reverted. Not allowed for viewers.",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: {
				slug: { type: "string", description: "Page ID or slug" },
			},
		},
		async handler(input, ctx) {
			const { slug } = input as { slug: string };
			return wikiService.verifyWikiPage(ctx as ServiceCtx, slug);
		},
	},
	{
		name: "list_stale_pages",
		description:
			"Maintenance queue of wiki pages that need re-verification: computed-stale " +
			"(verify_interval elapsed since verified_at), unverified (verify_interval declared but " +
			"never verified), or explicitly status: stale|deprecated. Same rule search_wiki uses to " +
			"demote results (R7).",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Restrict to pages belonging to this project ID",
				},
				limit: { type: "number", default: 50 },
				offset: { type: "number", default: 0 },
			},
		},
		async handler(input, ctx) {
			return wikiService.listStaleWikiPages(ctx, input);
		},
	},
	{
		name: "list_wiki_templates",
		description:
			"List pages flagged as templates (frontmatter `template: true`) — the picker " +
			"create_wiki_page's `templateSlug` draws from. Templates are conventionally " +
			"workspace-global (living under a workspace 'Templates' page) but a project-scoped " +
			"template is allowed and follows the same project-visibility rule as any other " +
			"project-scoped page.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Restrict to templates belonging to this project ID",
				},
			},
		},
		async handler(input, ctx) {
			return wikiService.listWikiTemplates(ctx, input);
		},
	},
];
