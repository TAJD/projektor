import type { MCPTool } from "@projektor/types";
import { WIKI_WELL_KNOWN_TYPES } from "../schemas/wiki";
import { ValidationError } from "../services/errors";
import type { ServiceCtx } from "../services/types";
import * as wikiService from "../services/wiki";
import * as wikiDraftsService from "../services/wiki-drafts";
import * as wikiWatchersService from "../services/wiki-watchers";

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
		name: "get_wiki_revision_diff",
		description:
			"Server-side unified diff between one revision (revisionId) and either another " +
			"revision or the page's current content. `against` is a revision id or the literal " +
			'string "current" (default when omitted). Same unified diff format as ' +
			"update_wiki_page/patch_wiki_page's conflict responses (--- base / +++ current, " +
			"@@ hunk headers).",
		inputSchema: {
			type: "object",
			required: ["slug", "revisionId"],
			properties: {
				slug: { type: "string" },
				revisionId: { type: "string" },
				against: {
					type: "string",
					description: 'Another revision id, or "current" (default)',
				},
			},
		},
		async handler(input, ctx) {
			const { slug, revisionId, against } = input as {
				slug: string;
				revisionId: string;
				against?: string;
			};
			return wikiService.getWikiRevisionDiff(ctx as ServiceCtx, slug, revisionId, { against });
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
	{
		name: "watch_wiki_page",
		description:
			"Watch a wiki page by id or slug — its changes (create is n/a here since the page " +
			"already exists, update/patch/verify/restore/delete) will generate a per-user " +
			"notification (list_wiki_notifications). Pass subtree=true to also watch every " +
			"page currently OR LATER nested under this one (resolved dynamically by walking " +
			"the page hierarchy at notify time, not a one-time snapshot). Calling this again " +
			"for the same page updates the subtree flag rather than creating a duplicate watch. " +
			"Template pages (frontmatter template: true) never generate notifications even if " +
			"watched directly or via a subtree.",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: {
				slug: { type: "string", description: "Page ID or slug" },
				subtree: {
					type: "boolean",
					default: false,
					description: "Also watch this page's current and future descendant pages",
				},
			},
		},
		async handler(input, ctx) {
			const { slug, ...rest } = input as { slug: string; subtree?: boolean };
			return wikiWatchersService.watchWikiPage(ctx as ServiceCtx, slug, rest);
		},
	},
	{
		name: "unwatch_wiki_page",
		description: "Stop watching a wiki page by id or slug (a no-op if not currently watched).",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: { slug: { type: "string", description: "Page ID or slug" } },
		},
		async handler(input, ctx) {
			const { slug } = input as { slug: string };
			return wikiWatchersService.unwatchWikiPage(ctx as ServiceCtx, slug);
		},
	},
	{
		name: "list_wiki_watches",
		description: "List the pages the calling user is currently watching.",
		inputSchema: { type: "object", properties: {} },
		async handler(_input, ctx) {
			return wikiWatchersService.listWikiWatches(ctx as ServiceCtx);
		},
	},
	{
		name: "list_wiki_notifications",
		description:
			"List the calling user's wiki watch notifications (newest first). Each entry " +
			"records the page (denormalized slug/title, so a notification about a page " +
			"that's since been deleted still shows what it was about), the action " +
			"(created|updated|deleted), the actor, and whether it's been read.",
		inputSchema: {
			type: "object",
			properties: {
				unreadOnly: { type: "boolean", default: false },
				limit: { type: "number", default: 50 },
				offset: { type: "number", default: 0 },
			},
		},
		async handler(input, ctx) {
			return wikiWatchersService.listWikiNotifications(ctx, input);
		},
	},
	{
		name: "mark_wiki_notifications_read",
		description: "Mark wiki notifications as read, by id, or all: true for every unread one.",
		inputSchema: {
			type: "object",
			properties: {
				ids: {
					type: "array",
					items: { type: "string" },
					description: "Notification IDs to mark read",
				},
				all: {
					type: "boolean",
					default: false,
					description: "Mark all of the caller's notifications read",
				},
			},
		},
		async handler(input, ctx) {
			return wikiWatchersService.markWikiNotificationsRead(ctx, input);
		},
	},
	{
		name: "list_wiki_changes",
		description:
			"Cheap delta feed of wiki page changes since a unix-seconds timestamp — for agents " +
			"polling 'what changed' instead of re-fetching/re-searching the whole wiki. Backed " +
			"by the existing activity log (no extra write-path cost). `since` is EXCLUSIVE; " +
			"poll again using the response's `nextSince`, not a locally-computed timestamp, so " +
			"changes landing on the same second as the cutoff are never missed or double-" +
			"delivered. Defaults to every wiki page the caller can see (same visibility as " +
			"list_wiki_pages/search_wiki) — pass watchedOnly=true to narrow to pages the caller " +
			"is watching (directly or via a subtree watch). A `deleted` entry's slug/title/" +
			"projectId reflect the page as it was just before deletion (the row itself is gone).",
		inputSchema: {
			type: "object",
			required: ["since"],
			properties: {
				since: {
					type: "number",
					description: "Unix seconds; only changes strictly after this are returned",
				},
				limit: { type: "number", default: 100 },
				projectId: { type: "string", description: "Restrict to changes on pages in this project" },
				watchedOnly: {
					type: "boolean",
					default: false,
					description: "Restrict to pages the caller is watching (directly or via subtree)",
				},
			},
		},
		async handler(input, ctx) {
			return wikiWatchersService.listWikiChanges(ctx, input);
		},
	},
	{
		name: "get_wiki_draft",
		description:
			"Get the calling user's saved server-side draft for a wiki page by id or slug " +
			"(PROJ-495/R13 — replaces the old localStorage-only autosave, so a draft survives " +
			"a device switch). Returns null if there is no draft. `baseRevisionId` is the " +
			"page's latest revision id as of when the draft was started — pass it straight " +
			"through to update_wiki_page/patch_wiki_page's own baseRevisionId when publishing, " +
			"so a stale draft hits the normal conflict response instead of silently clobbering " +
			"someone else's newer edit.",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: { slug: { type: "string", description: "Page ID or slug" } },
		},
		async handler(input, ctx) {
			const { slug } = input as { slug: string };
			return wikiDraftsService.getWikiDraft(ctx as ServiceCtx, slug);
		},
	},
	{
		name: "save_wiki_draft",
		description:
			"Save (upsert) the calling user's draft for a wiki page by id or slug. One draft " +
			"per (page, user) — calling this again overwrites the previous draft rather than " +
			"creating a new one. Not a revision and not visible to other users. Callers should " +
			"debounce their own call frequency (e.g. ~1s after the last edit) — this tool does " +
			"no server-side throttling.",
		inputSchema: {
			type: "object",
			required: ["slug", "title", "content"],
			properties: {
				slug: { type: "string", description: "Page ID or slug" },
				title: { type: "string" },
				content: { type: "string" },
				baseRevisionId: {
					type: "string",
					description:
						"The page's latest revision id when this draft was started; null if the " +
						"page had no revisions yet",
				},
			},
		},
		async handler(input, ctx) {
			const { slug, ...rest } = input as { slug: string; title: string; content: string };
			return wikiDraftsService.saveWikiDraft(ctx as ServiceCtx, slug, rest);
		},
	},
	{
		name: "discard_wiki_draft",
		description:
			"Delete the calling user's draft for a wiki page by id or slug (a no-op if there " +
			"is none). Call this after a successful publish, or whenever the user explicitly " +
			"discards unsaved changes.",
		inputSchema: {
			type: "object",
			required: ["slug"],
			properties: { slug: { type: "string", description: "Page ID or slug" } },
		},
		async handler(input, ctx) {
			const { slug } = input as { slug: string };
			return wikiDraftsService.discardWikiDraft(ctx as ServiceCtx, slug);
		},
	},
	{
		name: "list_wiki_trash",
		description:
			"List trashed (soft-deleted) wiki pages in the workspace, optionally scoped to a " +
			"project. Same visibility rule as list_wiki_pages — a project-scoped trashed page " +
			"only appears for callers who could see that project. Each result includes " +
			"`purgeAfter` (unix seconds) — the page is permanently removed by purge_wiki_trash " +
			"once that time passes (30 days after deletion).",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Restrict to trashed pages belonging to this project ID",
				},
				limit: { type: "number", default: 50 },
				offset: { type: "number", default: 0 },
			},
		},
		async handler(input, ctx) {
			return wikiService.listWikiTrash(ctx, input);
		},
	},
	{
		name: "undelete_wiki_page",
		description:
			"Restore a trashed wiki page by ID (not slug — a slug is only unique among live " +
			"pages, so more than one trashed page can share the same now-recycled slug; use " +
			"list_wiki_trash to find the ID). Requires the same permission as delete_wiki_page. " +
			"If this page was cascade-trashed together with descendants, the whole subtree is " +
			"restored as one batch — the response's restoredCount reports how many pages came " +
			"back. Rejected with a structured conflict (no partial restore) if the ID's own " +
			"slug OR any descendant's slug has since been taken by another live page — the " +
			"conflict names the colliding slug; rename that page first, then retry. The " +
			"restored page's parent may itself still be trashed; if so the page appears as a " +
			"root until the parent is also restored.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string", description: "Trashed page ID" } },
		},
		async handler(input, ctx) {
			const { id } = input as { id: string };
			return wikiService.undeleteWikiPage(ctx as ServiceCtx, id);
		},
	},
	{
		name: "purge_wiki_trash",
		description:
			"Permanently remove every wiki page in the workspace that's been trashed for at " +
			"least 30 days — deletes R2 attachment objects, wiki_revisions/wiki_links/" +
			"wiki_watchers/wiki_drafts/wiki_redirects rows, and the page row itself, re-parenting " +
			"any live child left pointing at a purged page. Irreversible. Owner/admin only. Also " +
			"runs automatically once daily via a Workers Cron Trigger — call this manually only " +
			"to force an off-cycle purge.",
		inputSchema: { type: "object", properties: {} },
		async handler(_input, ctx) {
			return wikiService.purgeExpiredWikiPages(ctx as ServiceCtx);
		},
	},
];
