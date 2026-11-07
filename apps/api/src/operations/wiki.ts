import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import { capPage, toPage } from "../mcp/serialize";
import {
	outlineOf,
	sectionOf,
	WIKI_DEFAULT_MAX_CHARS,
	WIKI_MAX_CHARS,
	windowText,
} from "../mcp/windowing";
import { WIKI_WELL_KNOWN_TYPES } from "../schemas/wiki";
import { ValidationError } from "../services/errors";
import * as wikiService from "../services/wiki";
import * as wikiDraftsService from "../services/wiki-drafts";
import * as wikiWatchersService from "../services/wiki-watchers";
import { defineOperation } from "./define";

const base = {
	domain: "wiki",
	keywords: ["wiki", "page", "doc", "documentation", "knowledge base", "note", "runbook"],
};

const WIKI = "/api/wiki";
const PAGE = `${WIKI}/:slug`;
const WIKI_CHANGES_DEFAULT_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const WELL_KNOWN_TYPES = WIKI_WELL_KNOWN_TYPES.join("|");

const TypeFilter = z
	.string()
	.min(1)
	.max(50)
	.optional()
	.meta({
		description:
			"Filter to pages whose frontmatter `type` matches (freeform; well-known " +
			`values are ${WELL_KNOWN_TYPES})`,
	});

const StatusFilter = z
	.enum(["draft", "current", "stale", "deprecated"])
	.optional()
	.meta({ description: "Filter to pages whose frontmatter `status` matches" });

const TagsFilter = z
	.union([z.string(), z.array(z.string()).max(50)])
	.optional()
	.meta({
		description:
			"Filter to pages carrying at least one of these frontmatter tags (array, or a comma-separated string)",
	});

const IncludeWorkspacePages = z
	.boolean()
	.optional()
	.meta({
		description:
			"When a projectId is given, also return workspace-level pages (those belonging to " +
			"no project). Default false — the projectId filter alone returns that project's " +
			"pages only.",
	});

const PageRef = z.string().meta({ description: "Page ID or slug" });

const Slug = { slug: z.string() };

const ByIdOrSlug = {
	id: z.string().optional().meta({ description: "Page ID" }),
	slug: z.string().optional().meta({ description: "Page slug (alternative to id)" }),
};

function pageRef(input: { id?: string; slug?: string }): string {
	const ref = input.slug ?? input.id;
	if (!ref) {
		throw new ValidationError({
			formErrors: ["Either id or slug must be provided"],
			fieldErrors: {},
		});
	}
	return ref;
}

const RevisionSummary = z.string().max(2000).optional().meta({
	description: "Optional edit message/changelog note, recorded on the created revision",
});

const Paging = (max: number) => ({
	limit: z.number().int().min(1).max(max).default(50),
	offset: z.number().int().min(0).default(0),
});

export const wikiOperations = [
	defineOperation({
		...base,
		id: "list_wiki_pages",
		method: "GET",
		path: WIKI,
		tier: "read",
		summary:
			"List wiki pages in the workspace, optionally filtered by parent, project, " +
			"frontmatter type/status, or tags (any-of match)",
		input: z.object({
			parentId: z.string().optional().meta({ description: "Filter to children of this page ID" }),
			projectId: z
				.string()
				.optional()
				.meta({ description: "Filter to pages belonging to this project ID" }),
			type: TypeFilter,
			status: StatusFilter,
			tags: TagsFilter,
			includeTemplates: z
				.boolean()
				.default(false)
				.meta({
					description:
						"Include template pages in the results (default false, matching search_wiki/" +
						"list_stale_pages). Use list_wiki_templates for the template-picker use case instead.",
				}),
			includeWorkspacePages: IncludeWorkspacePages,
			sort: z
				.enum(["title", "updated"])
				.default("title")
				.meta({ description: "Order by title (default) or most recently updated first" }),
			limit: z
				.number()
				.int()
				.min(1)
				.max(500)
				.optional()
				.meta({ description: "Return at most this many pages (default: all)" }),
		}),
		run: (ctx, input) => wikiService.listWikiPages(ctx, input),
	}),
	defineOperation({
		...base,
		id: "wiki_tree",
		method: "GET",
		path: `${WIKI}/tree`,
		tier: "read",
		summary:
			"Get the wiki page hierarchy as a nested tree, optionally filtered by project. Returns " +
			"`{items}` — the root nodes (see /projektor/agents/response-conventions/).",
		input: z.object({
			projectId: z
				.string()
				.optional()
				.meta({ description: "Filter to pages belonging to this project ID" }),
			includeWorkspacePages: IncludeWorkspacePages,
		}),
		run: (ctx, input) => wikiService.getWikiTree(ctx, input),
		mcpResult: (result) => toPage(result as unknown[]),
	}),
	defineOperation({
		...base,
		id: "search_wiki",
		method: "GET",
		path: `${WIKI}/search`,
		tier: "read",
		restAliases: { q: "query" },
		summary:
			"Full-text search over wiki pages (FTS5, BM25-ranked, title weighted above body). " +
			"Returns match-anchored snippets highlighted with ** markers, plus a computed " +
			"`freshness` ({state, staleSince} or null if the page has no verify_interval/status " +
			"signal) per result. type/status/tags filter on the denormalised frontmatter columns " +
			"(R6). Results are demoted (ranked below everything else, ties broken by bm25 within " +
			"each tier) when the page is computed-stale/unverified OR has an explicit " +
			"status: stale|deprecated (R7). Returns `{items, next?}` — pass `next` back as `cursor`. " +
			"See /projektor/agents/response-conventions/.",
		input: z.object({
			query: z.string(),
			limit: z.number().int().min(1).max(50).default(10),
			offset: z.number().int().min(0).default(0),
			cursor: z
				.string()
				.regex(/^\d+$/)
				.optional()
				.meta({ description: "Pass the previous page's `next` unchanged (replaces offset)" }),
			projectId: z.string().optional().meta({ description: "Restrict search to this project ID" }),
			updatedSince: z.number().int().min(0).optional().meta({
				description: "Unix seconds — only return pages updated at or after this time",
			}),
			type: TypeFilter,
			tags: TagsFilter,
			status: StatusFilter,
			includeWorkspacePages: IncludeWorkspacePages,
		}),
		run: (ctx, { cursor, ...rest }) =>
			wikiService.searchWiki(
				ctx,
				cursor === undefined ? rest : { ...rest, offset: Number(cursor) }
			),
		mcpResult: (result, input) => {
			const items = result as unknown[];
			const offset = input.cursor === undefined ? input.offset : Number(input.cursor);
			const page = toPage(items, items.length >= input.limit ? offset + input.limit : null);
			return capPage(page, { cursorOf: (i) => String(offset + i + 1) });
		},
	}),
	defineOperation({
		...base,
		id: "list_broken_wiki_links",
		method: "GET",
		path: `${WIKI}/broken-links`,
		tier: "read",
		summary:
			"List unresolved wiki links in the workspace — [[Target]]/URL links whose target " +
			"title or slug didn't match any page at write time. Useful as a maintenance queue. " +
			"A broken link auto-resolves when a page matching its title/slug is created, " +
			"renamed to match it, or restored from the trash (PROJ-814); backfill_wiki_links " +
			"(or re-saving the linking page) also still re-resolves it.",
		input: z.object({
			projectId: z
				.string()
				.optional()
				.meta({ description: "Restrict to links from pages in this project" }),
		}),
		run: (ctx, input) => wikiService.listBrokenWikiLinks(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_stale_pages",
		method: "GET",
		path: `${WIKI}/stale-pages`,
		tier: "read",
		summary:
			"Maintenance queue of wiki pages that need re-verification: computed-stale " +
			"(verify_interval elapsed since verified_at), unverified (verify_interval declared but " +
			"never verified), or explicitly status: stale|deprecated. Same rule search_wiki uses to " +
			"demote results (R7).",
		input: z.object({
			projectId: z
				.string()
				.optional()
				.meta({ description: "Restrict to pages belonging to this project ID" }),
			...Paging(200),
			includeWorkspacePages: IncludeWorkspacePages,
		}),
		run: (ctx, input) => wikiService.listStaleWikiPages(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_wiki_templates",
		method: "GET",
		path: `${WIKI}/templates`,
		tier: "read",
		summary:
			"List pages flagged as templates (frontmatter `template: true`) — the picker " +
			"create_wiki_page's `templateSlug` draws from. Templates are conventionally " +
			"workspace-global (living under a workspace 'Templates' page) but a project-scoped " +
			"template is allowed and follows the same project-visibility rule as any other " +
			"project-scoped page.",
		input: z.object({
			projectId: z
				.string()
				.optional()
				.meta({ description: "Restrict to templates belonging to this project ID" }),
		}),
		run: (ctx, input) => wikiService.listWikiTemplates(ctx, input),
	}),
	defineOperation({
		...base,
		id: "backfill_wiki_links",
		method: "POST",
		path: `${WIKI}/backfill-links`,
		tier: "write",
		minRole: "admin",
		annotations: PLAIN_WRITE,
		summary:
			"Idempotent, safe-to-re-run recompute of the wiki_links graph for pages in the " +
			"workspace, one page-budget-sized chunk per call (default 200, max 500) so it can run " +
			"incrementally and resume after a timeout. Skips trashed pages. Pass back `nextCursor` " +
			"as `cursor` to continue; call repeatedly until `nextCursor` is null. `updatedSince` " +
			"(unix seconds) limits the scope to pages touched at/after that time. Owner/admin only.",
		input: z.object({
			cursor: z
				.object({ updatedAt: z.number().int().min(0), id: z.string().min(1) })
				.nullish()
				.meta({ description: "Resume point from a previous call's nextCursor" }),
			pageBudget: z
				.number()
				.int()
				.min(1)
				.max(500)
				.optional()
				.meta({ description: "Max pages to process in this call (1-500, default 200)" }),
			updatedSince: z.number().int().min(0).optional().meta({
				description: "Only process pages updated at/after this unix-seconds timestamp",
			}),
		}),
		run: (ctx, input) => wikiService.backfillWikiLinks(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_wiki_watches",
		method: "GET",
		path: `${WIKI}/watches`,
		tier: "read",
		summary: "List the pages the calling user is currently watching.",
		input: z.object({}),
		run: (ctx) => wikiWatchersService.listWikiWatches(ctx),
	}),
	defineOperation({
		...base,
		id: "list_wiki_notifications",
		method: "GET",
		path: `${WIKI}/notifications`,
		tier: "read",
		summary:
			"List the calling user's wiki watch notifications (newest first). Each entry " +
			"records the page (denormalised slug/title, so a notification about a page " +
			"that's since been deleted still shows what it was about), the action " +
			"(created|updated|deleted), the actor, and whether it's been read.",
		input: z.object({ unreadOnly: z.boolean().default(false), ...Paging(200) }),
		run: (ctx, input) => wikiWatchersService.listWikiNotifications(ctx, input),
	}),
	defineOperation({
		...base,
		id: "mark_wiki_notifications_read",
		method: "POST",
		path: `${WIKI}/notifications/read`,
		tier: "write",
		annotations: PLAIN_WRITE,
		summary: "Mark wiki notifications as read, by id, or all: true for every unread one.",
		input: z.object({
			ids: z
				.array(z.string())
				.max(200)
				.optional()
				.meta({ description: "Notification IDs to mark read" }),
			all: z
				.boolean()
				.default(false)
				.meta({ description: "Mark all of the caller's notifications read" }),
		}),
		run: (ctx, input) => wikiWatchersService.markWikiNotificationsRead(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_wiki_trash",
		method: "GET",
		path: `${WIKI}/trash`,
		tier: "read",
		summary:
			"List trashed (soft-deleted) wiki pages in the workspace, optionally scoped to a " +
			"project. Same visibility rule as list_wiki_pages — a project-scoped trashed page " +
			"only appears for callers who could see that project. Each result includes " +
			"`purgeAfter` (unix seconds) — the page is permanently removed by purge_wiki_trash " +
			"once that time passes (30 days after deletion).",
		input: z.object({
			projectId: z
				.string()
				.optional()
				.meta({ description: "Restrict to trashed pages belonging to this project ID" }),
			...Paging(200),
		}),
		run: (ctx, input) => wikiService.listWikiTrash(ctx, input),
	}),
	defineOperation({
		...base,
		id: "undelete_wiki_page",
		method: "POST",
		path: `${WIKI}/trash/:id/undelete`,
		tier: "write",
		annotations: PLAIN_WRITE,
		summary:
			"Restore a trashed wiki page by ID (not slug — trashed pages can share a " +
			"now-recycled slug; use list_wiki_trash to find the ID). Requires the same " +
			"permission as delete_wiki_page. " +
			"If this page was cascade-trashed together with descendants, the whole subtree is " +
			"restored as one batch — the response's restoredCount reports how many pages came " +
			"back. Rejected with a structured conflict (no partial restore) if the ID's own " +
			"slug OR any descendant's slug has since been taken by another live page — the " +
			"conflict names the colliding slug; rename that page first, then retry. The " +
			"restored page's parent may itself still be trashed; if so the page appears as a " +
			"root until the parent is also restored.",
		input: z.object({ id: z.string().min(1).meta({ description: "Trashed page ID" }) }),
		run: (ctx, { id }) => wikiService.undeleteWikiPage(ctx, id),
	}),
	defineOperation({
		...base,
		id: "purge_wiki_trash",
		method: "POST",
		path: `${WIKI}/purge-trash`,
		tier: "destructive",
		summary:
			"Permanently remove every wiki page in the workspace that's been trashed for at " +
			"least 30 days — deletes R2 attachment objects, wiki_revisions/wiki_links/" +
			"wiki_watchers/wiki_drafts/wiki_redirects rows, and the page row itself, re-parenting " +
			"any live child left pointing at a purged page. Irreversible. Owner/admin only. Also " +
			"runs automatically once daily via a Workers Cron Trigger — call this manually only " +
			"to force an off-cycle purge.",
		input: z.object({}),
		run: (ctx) => wikiService.purgeExpiredWikiPages(ctx),
	}),
	defineOperation({
		...base,
		id: "list_wiki_changes",
		method: "GET",
		path: `${WIKI}/changes`,
		tier: "read",
		summary:
			"Cheap delta feed of wiki page changes since a unix-seconds timestamp — for agents " +
			"polling 'what changed' instead of re-fetching/re-searching the whole wiki. " +
			"`since` is EXCLUSIVE; " +
			"poll again passing the response's `next` as `cursor`, not a locally-computed timestamp, so " +
			"changes landing on the same second as the cutoff are never missed or double-" +
			"delivered. Defaults to every wiki page the caller can see (same visibility as " +
			"list_wiki_pages/search_wiki) — pass watchedOnly=true to narrow to pages the caller " +
			"is watching (directly or via a subtree watch). A `deleted` entry's slug/title/" +
			"projectId reflect the page as it was just before deletion (the row itself is gone).",
		input: z.object({
			since: z.number().optional().meta({
				description:
					"Unix seconds; only changes strictly after this are returned. Defaults to 7 days ago",
			}),
			cursor: z
				.string()
				.optional()
				.meta({ description: "Pass the previous page's `next` unchanged (replaces `since`)" }),
			limit: z.number().int().min(1).max(500).default(100),
			projectId: z
				.string()
				.optional()
				.meta({ description: "Restrict to changes on pages in this project" }),
			watchedOnly: z.boolean().default(false).meta({
				description: "Restrict to pages the caller is watching (directly or via subtree)",
			}),
		}),
		run: async (ctx, { cursor, ...rest }) => {
			const since = cursor
				? Number(cursor)
				: (rest.since ?? Math.floor(Date.now() / 1000) - WIKI_CHANGES_DEFAULT_WINDOW_SECONDS);
			if (Number.isNaN(since)) {
				throw new ValidationError({
					formErrors: [],
					fieldErrors: { cursor: ["pass the previous page's `next` unchanged"] },
				});
			}
			return { ...(await wikiWatchersService.listWikiChanges(ctx, { ...rest, since })), since };
		},
		mcpResult: (result) => {
			const r = result as {
				changes: Array<{ createdAt: number }>;
				nextSince: number;
				since: number;
			};
			const since = r.since;
			const events = r.changes;
			const page = toPage(events, r.nextSince > since ? r.nextSince : null);
			return capPage(page, {
				cursorOf: (i) => String(events[i].createdAt),
				canCutAt: (kept) => events[kept - 1].createdAt !== events[kept]?.createdAt,
			});
		},
	}),
	defineOperation({
		...base,
		id: "create_wiki_page",
		method: "POST",
		path: WIKI,
		tier: "write",
		status: 201,
		summary:
			"Create a new wiki page. `content` may start with an optional YAML frontmatter block " +
			"(`---\\ntype: runbook\\ntags: [foo]\\nstatus: draft\\n---\\n...`) — type (freeform; " +
			`well-known values ${WELL_KNOWN_TYPES}), tags[], status (draft|current|stale|` +
			"deprecated), verified_at, verified_by, owners[], verify_interval (days), template " +
			"(boolean) are parsed and denormalised for filtering. Invalid frontmatter (bad status/" +
			"enum, wrong type, unrecognised key) is rejected with a structured error, not ignored. " +
			"Alternatively, pass `templateSlug` (from " +
			"list_wiki_templates) to seed this page's content from an existing template page — " +
			"its `template: true` flag is stripped from the seeded content (the new page is not " +
			"itself a template). `templateSlug` and `content` are mutually exclusive; a " +
			"`templateSlug` that doesn't resolve to a page flagged template:true is rejected.",
		input: z.object({
			title: z.string().min(1).max(300),
			slug: z.string().min(1).max(200).optional().meta({
				description: "URL-safe identifier; auto-generated from title if omitted",
			}),
			content: z
				.string()
				.max(500000)
				.optional()
				.meta({
					description:
						"Markdown content, optionally starting with a YAML frontmatter block. " +
						"Mutually exclusive with templateSlug.",
				}),
			templateSlug: z
				.string()
				.min(1)
				.max(200)
				.optional()
				.meta({
					description:
						"Seed this page's content from the template page at this slug/id (see " +
						"list_wiki_templates). Mutually exclusive with content.",
				}),
			parentId: z.string().optional().meta({ description: "Parent page ID for nested pages" }),
			projectId: z.string().optional().meta({ description: "Project ID to scope this page to" }),
		}),
		run: (ctx, input) => wikiService.createWikiPage(ctx, input),
	}),
	defineOperation({
		...base,
		id: "get_backlinks",
		method: "GET",
		path: `${PAGE}/backlinks`,
		tier: "read",
		summary:
			"List pages that link to the given page via a resolved [[wikilink]] or same-workspace " +
			"URL (id-backed, so renames never break a backlink). Each result includes a snippet of " +
			"the citing text when it can still be located in the source page's current content.",
		input: z.object({
			slug: z.string().meta({ description: "Page ID or slug to find backlinks for" }),
		}),
		run: (ctx, { slug }) => wikiService.getWikiBacklinks(ctx, slug),
	}),
	defineOperation({
		...base,
		id: "get_wiki_revision",
		method: "GET",
		path: `${PAGE}/revisions/:revisionId`,
		tier: "read",
		summary: "Get the content of a specific wiki revision by its ID",
		input: z.object({ ...Slug, revisionId: z.string() }),
		run: (ctx, { slug, revisionId }) => wikiService.getWikiRevision(ctx, slug, revisionId),
	}),
	defineOperation({
		...base,
		id: "get_wiki_revision_diff",
		method: "GET",
		path: `${PAGE}/revisions/:revisionId/diff`,
		tier: "read",
		summary:
			"Server-side unified diff between one revision (revisionId) and either another " +
			"revision or the page's current content. `against` is a revision id or the literal " +
			'string "current" (default when omitted). Same unified diff format as ' +
			"update_wiki_page/patch_wiki_page's conflict responses (--- base / +++ current, " +
			"@@ hunk headers).",
		input: z.object({
			...Slug,
			revisionId: z.string(),
			against: z
				.string()
				.min(1)
				.optional()
				.meta({ description: 'Another revision id, or "current" (default)' }),
		}),
		run: (ctx, { slug, revisionId, against }) =>
			wikiService.getWikiRevisionDiff(ctx, slug, revisionId, { against }),
	}),
	defineOperation({
		...base,
		id: "list_wiki_revisions",
		method: "GET",
		path: `${PAGE}/revisions`,
		tier: "read",
		summary: "List revision history for a wiki page",
		input: z.object(Slug),
		run: (ctx, { slug }) => wikiService.listWikiRevisions(ctx, slug),
	}),
	defineOperation({
		...base,
		id: "get_wiki_page",
		method: "GET",
		path: PAGE,
		tier: "read",
		versioned: true,
		summary:
			"Get a wiki page by slug. Long pages are windowed: `content` is at most `maxChars` " +
			"(default 8000, max 20000) and `totalChars` is the full length; when `next` is present pass it " +
			"back as `cursor` for the following window. `outline` lists the page's headings — pass " +
			"`section` (a heading's text or slug) to read just that section. Pass the returned " +
			"`revisionId` as `baseRevisionId` when you update or patch the page. " +
			"`contentTruncated:true` means `content` is only part of the page: NEVER pass it back to " +
			"update_wiki_page (that would overwrite the page with the fragment) — use patch_wiki_page. " +
			"See /projektor/agents/response-conventions/.",
		input: z.object({
			...Slug,
			maxChars: z
				.number()
				.int()
				.min(1)
				.max(WIKI_MAX_CHARS)
				.default(WIKI_DEFAULT_MAX_CHARS)
				.meta({ description: `Max characters of content per call (1-${WIKI_MAX_CHARS})` }),
			cursor: z
				.string()
				.optional()
				.meta({ description: "Pass the previous window's `next` unchanged" }),
			section: z.string().optional().meta({
				description: "Return only this section (a heading's text or slug, from `outline`)",
			}),
		}),
		run: (ctx, { slug }) => wikiService.getWikiPage(ctx, slug),
		headers: (page) => ({
			ETag: `"${(page as { revisionId?: string | null }).revisionId ?? "none"}"`,
		}),
		mcpResult: (result, { maxChars: max, cursor, section }) => {
			const page = result as { content?: string | null } & Record<string, unknown>;
			const full = page.content ?? "";
			const outline = outlineOf(full);
			const { content: _full, ...rest } = page;
			if (section !== undefined) {
				const body = sectionOf(full, section);
				if (body === undefined) return { ...rest, outline, section, sectionFound: false };
				const w = windowText(body, { max, cursor });
				return {
					...rest,
					outline,
					section,
					content: w.text,
					totalChars: w.totalChars,
					contentTruncated: true,
					...(w.next ? { next: w.next } : {}),
				};
			}
			const w = windowText(full, { max, cursor });
			return {
				...rest,
				outline,
				content: w.text,
				totalChars: w.totalChars,
				...(w.next || cursor !== undefined ? { contentTruncated: true } : {}),
				...(w.next ? { next: w.next } : {}),
			};
		},
	}),
	defineOperation({
		...base,
		id: "update_wiki_page",
		method: "PUT",
		path: PAGE,
		tier: "write",
		annotations: PLAIN_WRITE,
		restAliases: { slug: "newSlug" },
		summary:
			"Update a wiki page by id or slug (saves a revision when content changes). Pass " +
			"baseRevisionId (the current revision id from list_wiki_revisions/get_wiki_revision, " +
			"or null if the page has never been revised) for conflict-safe writes: if the page " +
			"advanced since baseRevisionId, the write is rejected with a structured conflict " +
			"(currentRevisionId + a unified diff) instead of silently overwriting. Omitting " +
			"baseRevisionId is DEPRECATED — it keeps today's last-write-wins behavior during the " +
			"transition and will be rejected in a future version. The revision pointer only " +
			"advances on content edits, so baseRevisionId doesn't cover title/slug/parentId-only " +
			"changes; those are last-write-wins against writes that finished before your call, " +
			"but any write that lands while your call is in flight returns a 409. `content` may include a YAML " +
			"frontmatter block (see create_wiki_page); it's re-parsed on every content edit, " +
			"replacing the page's previously-stored metadata. Omitting `content` leaves the " +
			"page's existing frontmatter metadata unchanged.",
		input: z.object({
			...ByIdOrSlug,
			title: z.string().min(1).max(300).optional(),
			content: z.string().max(500000).optional().meta({
				description: "Markdown content, optionally starting with a YAML frontmatter block",
			}),
			parentId: z.string().nullable().optional().meta({
				description: "Parent page ID (null to unset parent, omit to leave unchanged)",
			}),
			newSlug: z.string().min(1).max(200).optional().meta({
				description:
					"Rename the page's slug; the old slug becomes a redirect so existing links keep resolving",
			}),
			baseRevisionId: z
				.string()
				.nullable()
				.optional()
				.meta({
					description:
						"Deprecated if omitted (see tool description). The revision id this edit is " +
						"based on — null if the page has never been revised.",
				}),
			summary: RevisionSummary,
		}),
		run: (ctx, { id, slug, newSlug, ...rest }) =>
			wikiService.updateWikiPage(
				ctx,
				pageRef({ id, slug }),
				newSlug !== undefined ? { ...rest, slug: newSlug } : rest
			),
	}),
	defineOperation({
		...base,
		id: "patch_wiki_page",
		method: "PATCH",
		path: PAGE,
		tier: "write",
		annotations: PLAIN_WRITE,
		summary:
			"Section-addressed patch operations on a wiki page's markdown, by id or slug. " +
			"Sections are addressed by heading text, with or without the leading `#` markers " +
			"(a `#`..`######` line and everything " +
			"up to the next heading; `#` lines inside fenced code blocks or the YAML " +
			"frontmatter block are not headings). A heading that appears more than once on " +
			"the page is ambiguous and rejected — patch targets must be unique. " +
			"Ops: append_to_section (add text at the end of the " +
			"section's body), replace_section (replace the section's body, heading kept), " +
			"insert_after_heading (insert text directly under the heading, before the " +
			"existing body), append_to_page (append at the very end of the document, no " +
			"heading needed), set_frontmatter (merge `values` into the page's YAML " +
			"frontmatter block without touching the rest of the content — a key set to " +
			"null is removed; a page with no frontmatter block gains one). " +
			"baseRevisionId is required for every op except append_to_page (the current revision id from " +
			"list_wiki_revisions/get_wiki_revision, or null if never revised) — conflict " +
			"detection is SECTION-scoped, not whole-page: two agents patching different " +
			"sections never conflict, even if the page's revision advanced between their " +
			"reads — only the SAME section changing underneath the caller conflicts " +
			"(append_to_page and set_frontmatter skip this check; baseRevisionId is only " +
			"validated as belonging to the page). A heading miss (never existed, or " +
			"deleted/renamed since baseRevisionId) returns the page's current headings so " +
			"a caller can retry against reality. Creates a revision like update_wiki_page; " +
			"ops other than set_frontmatter leave frontmatter metadata untouched beyond " +
			"reparsing it (never stamps verified_at).",
		input: z.object({
			...ByIdOrSlug,
			op: z
				.string()
				.optional()
				.meta({
					enum: [
						"append_to_section",
						"replace_section",
						"insert_after_heading",
						"append_to_page",
						"set_frontmatter",
					],
				}),
			heading: z
				.string()
				.optional()
				.meta({
					description:
						"Target section's heading text (required for append_to_section, " +
						"replace_section, insert_after_heading)",
				}),
			text: z.string().optional().meta({
				description: "Text to add/replace (required for every op except set_frontmatter)",
			}),
			content: z.string().optional().meta({
				description: "Alias of `text`, matching create_wiki_page/update_wiki_page",
			}),
			values: z
				.record(z.string(), z.unknown())
				.optional()
				.meta({
					description:
						"set_frontmatter only: frontmatter keys to set (type, tags, status, " +
						"verified_at, verified_by, owners, verify_interval, template). A key set " +
						"to null is removed from the page's frontmatter.",
				}),
			baseRevisionId: z
				.string()
				.nullable()
				.optional()
				.meta({
					description:
						"The revision id this patch is based on — null if the page has never been revised. " +
						"Required except for append_to_page.",
				}),
			summary: RevisionSummary,
		}),
		run: (ctx, { id, slug, ...rest }) =>
			wikiService.patchWikiPage(ctx, pageRef({ id, slug }), rest),
	}),
	defineOperation({
		...base,
		id: "delete_wiki_page",
		method: "DELETE",
		path: PAGE,
		tier: "destructive",
		summary:
			"Delete a wiki page by slug (not allowed for viewers). By default any child pages are " +
			"promoted to the deleted page's parent; pass cascade=true to delete the whole subtree instead.",
		input: z.object({
			slug: z.string().min(1),
			cascade: z.boolean().default(false).meta({
				description: "Delete all descendant pages too, instead of promoting them",
			}),
		}),
		run: (ctx, { slug, cascade }) => wikiService.deleteWikiPage(ctx, slug, { cascade }),
	}),
	defineOperation({
		...base,
		id: "verify_wiki_page",
		method: "POST",
		path: `${PAGE}/verify`,
		tier: "write",
		annotations: PLAIN_WRITE,
		summary:
			"Stamp a wiki page as freshly verified — sets its frontmatter verified_at to now and " +
			"verified_by to the CALLING user's email (never caller-supplied). Rewrites the page's " +
			"frontmatter block (creating one if it had none) and records a revision, same as any " +
			"other content edit — including its conflict check, so a concurrent edit racing the " +
			"stamp is rejected rather than reverted. Not allowed for viewers.",
		input: z.object({ slug: PageRef }),
		run: (ctx, { slug }) => wikiService.verifyWikiPage(ctx, slug),
	}),
	defineOperation({
		...base,
		id: "watch_wiki_page",
		method: "POST",
		path: `${PAGE}/watch`,
		tier: "write",
		annotations: PLAIN_WRITE,
		summary:
			"Watch a wiki page by id or slug — its changes (create is n/a here since the page " +
			"already exists, update/patch/verify/restore/delete) will generate a per-user " +
			"notification (list_wiki_notifications). Pass subtree=true to also watch every " +
			"page currently OR LATER nested under this one (resolved dynamically by walking " +
			"the page hierarchy at notify time, not a one-time snapshot). Calling this again " +
			"for the same page updates the subtree flag rather than creating a duplicate watch. " +
			"Template pages (frontmatter template: true) never generate notifications even if " +
			"watched directly or via a subtree.",
		input: z.object({
			slug: PageRef,
			subtree: z.boolean().default(false).meta({
				description: "Also watch this page's current and future descendant pages",
			}),
		}),
		run: (ctx, { slug, ...rest }) => wikiWatchersService.watchWikiPage(ctx, slug, rest),
	}),
	defineOperation({
		...base,
		id: "unwatch_wiki_page",
		method: "DELETE",
		path: `${PAGE}/watch`,
		tier: "write",
		annotations: PLAIN_WRITE,
		summary: "Stop watching a wiki page by id or slug (a no-op if not currently watched).",
		input: z.object({ slug: PageRef }),
		run: (ctx, { slug }) => wikiWatchersService.unwatchWikiPage(ctx, slug),
	}),
	defineOperation({
		...base,
		id: "get_wiki_draft",
		method: "GET",
		path: `${PAGE}/draft`,
		tier: "read",
		summary:
			"Get the calling user's saved server-side draft for a wiki page by id or slug " +
			"(server-side, so a draft survives a device switch). Returns null if there is no " +
			"draft. `baseRevisionId` is the " +
			"page's latest revision id as of when the draft was started — pass it straight " +
			"through to update_wiki_page/patch_wiki_page's own baseRevisionId when publishing, " +
			"so a stale draft hits the normal conflict response instead of silently clobbering " +
			"someone else's newer edit.",
		input: z.object({ slug: PageRef }),
		run: (ctx, { slug }) => wikiDraftsService.getWikiDraft(ctx, slug),
	}),
	defineOperation({
		...base,
		id: "save_wiki_draft",
		method: "PUT",
		path: `${PAGE}/draft`,
		tier: "write",
		annotations: PLAIN_WRITE,
		summary:
			"Save (upsert) the calling user's draft for a wiki page by id or slug. One draft " +
			"per (page, user) — calling this again overwrites the previous draft rather than " +
			"creating a new one. Not a revision and not visible to other users. Callers should " +
			"debounce their own call frequency (e.g. ~1s after the last edit) — this tool does " +
			"no server-side throttling.",
		input: z.object({
			slug: PageRef,
			title: z.string().min(1).max(300),
			content: z.string().max(500000),
			baseRevisionId: z
				.string()
				.nullable()
				.optional()
				.meta({
					description:
						"The page's latest revision id when this draft was started; null if the " +
						"page had no revisions yet",
				}),
		}),
		run: (ctx, { slug, ...rest }) => wikiDraftsService.saveWikiDraft(ctx, slug, rest),
	}),
	defineOperation({
		...base,
		id: "discard_wiki_draft",
		method: "DELETE",
		path: `${PAGE}/draft`,
		tier: "destructive",
		summary:
			"Delete the calling user's draft for a wiki page by id or slug (a no-op if there " +
			"is none). Call this after a successful publish, or whenever the user explicitly " +
			"discards unsaved changes.",
		input: z.object({ slug: PageRef }),
		run: (ctx, { slug }) => wikiDraftsService.discardWikiDraft(ctx, slug),
	}),
];
