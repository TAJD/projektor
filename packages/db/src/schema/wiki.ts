import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users, workspaces } from "./core";
import { projects } from "./issues";

export const wikiPages = sqliteTable(
	"wiki_pages",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		title: text("title").notNull(),
		content: text("content").notNull().default(""),
		parentId: text("parent_id"),
		createdById: text("created_by_id")
			.notNull()
			.references(() => users.id),
		updatedById: text("updated_by_id")
			.notNull()
			.references(() => users.id),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		// PROJ-488 (R6): denormalized from optional YAML frontmatter parsed on write
		// (services/wiki-frontmatter.ts). `type`/`status` are freeform TEXT — the
		// well-known enum values are enforced at the Zod layer, not a DB CHECK
		// constraint, so this column never blocks a write the schema layer would allow.
		type: text("type"),
		tags: text("tags", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.$defaultFn(() => []),
		status: text("status"),
		verifiedAt: integer("verified_at"),
		verifiedBy: text("verified_by"),
		owners: text("owners", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.$defaultFn(() => []),
		verifyInterval: integer("verify_interval"),
		// PROJ-491 (R9): denormalized from frontmatter `template: true` (services/
		// wiki-frontmatter.ts). Marks a page as a reusable template (conventionally
		// living under a workspace "Templates" page) rather than regular content.
		isTemplate: integer("is_template", { mode: "boolean" }).notNull().default(false),
		// PROJ-496 (R14): unix seconds this page was soft-deleted, or NULL if live.
		// Everything a hard delete used to clean up immediately (R2 objects, wiki_links,
		// wiki_watchers, wiki_drafts, wiki_fts) now waits until purgeExpiredWikiPages
		// actually removes the row, 30+ days later (services/wiki.ts).
		deletedAt: integer("deleted_at"),
	},
	(t) => ({
		wsSlugIdx: index("wiki_pages_workspace_slug_idx").on(t.workspaceId, t.slug),
		// PROJ-483: enforces slug uniqueness per workspace (0041_wiki_slug_unique.sql).
		// PROJ-496: PARTIAL — only among live pages — so trashing a page immediately frees
		// its slug for reuse rather than reserving it for the whole 30-day retention window.
		wsSlugUniqueIdx: uniqueIndex("wiki_pages_workspace_slug_unique_idx")
			.on(t.workspaceId, t.slug)
			.where(sql`${t.deletedAt} IS NULL`),
		parentIdx: index("wiki_pages_parent_idx").on(t.parentId),
		projectIdx: index("wiki_pages_project_id_idx").on(t.projectId),
		// PROJ-488: type/status filtering (listWikiPages/searchWiki).
		workspaceTypeIdx: index("wiki_pages_workspace_type_idx").on(t.workspaceId, t.type),
		workspaceStatusIdx: index("wiki_pages_workspace_status_idx").on(t.workspaceId, t.status),
		// PROJ-491: template picker / search+staleness exclusion filter on this flag.
		workspaceTemplateIdx: index("wiki_pages_workspace_template_idx").on(
			t.workspaceId,
			t.isTemplate
		),
		// PROJ-496: trash listing / purge job scan (services/wiki.ts#listWikiTrash,
		// #purgeExpiredWikiPages).
		workspaceDeletedAtIdx: index("wiki_pages_workspace_deleted_at_idx").on(
			t.workspaceId,
			t.deletedAt
		),
	})
);

export const wikiRevisions = sqliteTable(
	"wiki_revisions",
	{
		id: text("id").primaryKey(),
		pageId: text("page_id")
			.notNull()
			.references(() => wikiPages.id, { onDelete: "cascade" }),
		content: text("content").notNull(),
		// PROJ-484: page title at the time of this revision (0042_wiki_revision_title_summary.sql).
		title: text("title").notNull().default(""),
		// PROJ-484: optional edit message/changelog note supplied by the writer.
		summary: text("summary"),
		authorId: text("author_id")
			.notNull()
			.references(() => users.id),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		pageIdx: index("wiki_revisions_page_idx").on(t.pageId),
	})
);

// PROJ-483: old slug -> page id, written whenever a page's slug changes (services/wiki.ts
// updateWikiPage). Redirects always point at the page's current id, never at another
// slug, so a page renamed repeatedly never forms a redirect -> redirect chain.
export const wikiRedirects = sqliteTable(
	"wiki_redirects",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		oldSlug: text("old_slug").notNull(),
		pageId: text("page_id")
			.notNull()
			.references(() => wikiPages.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		workspaceOldSlugIdx: uniqueIndex("wiki_redirects_workspace_old_slug_idx").on(
			t.workspaceId,
			t.oldSlug
		),
		pageIdIdx: index("wiki_redirects_page_id_idx").on(t.pageId),
	})
);

// PROJ-485: server-side wiki link graph. Recomputed (delete-then-reinsert) on every
// content write by services/wiki-links.ts#reindexWikiLinks. targetPageId is nullable —
// null means the parsed [[Target]]/URL link didn't resolve to a page in this workspace
// at write time (a broken link); targetTitle always holds the raw parsed text so it
// survives later renames and stays available for broken-link reporting/re-resolution.
export const wikiLinks = sqliteTable(
	"wiki_links",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		sourcePageId: text("source_page_id")
			.notNull()
			.references(() => wikiPages.id, { onDelete: "cascade" }),
		targetPageId: text("target_page_id").references(() => wikiPages.id, { onDelete: "set null" }),
		targetTitle: text("target_title").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		sourcePageIdx: index("wiki_links_source_page_idx").on(t.sourcePageId),
		workspaceTargetIdx: index("wiki_links_workspace_target_idx").on(t.workspaceId, t.targetPageId),
	})
);

// PROJ-493 (R11): a user watching either a single page (subtree=false) or a page and its
// whole current+future subtree (subtree=true). "Is user watching page P" is resolved by
// walking P's parent_id chain at notify time (services/wiki-watchers.ts), not by
// materializing per-descendant rows — a page added later under a watched subtree is
// covered automatically.
export const wikiWatchers = sqliteTable(
	"wiki_watchers",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		pageId: text("page_id")
			.notNull()
			.references(() => wikiPages.id, { onDelete: "cascade" }),
		subtree: integer("subtree", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		userPageUniqueIdx: uniqueIndex("wiki_watchers_user_page_idx").on(
			t.workspaceId,
			t.userId,
			t.pageId
		),
		pageIdx: index("wiki_watchers_page_idx").on(t.workspaceId, t.pageId),
	})
);

// PROJ-493 (R11): per-user notification list. `pageId` is NOT a foreign key (and has no
// ON DELETE behavior) — a page that's since been hard-deleted must still leave its
// deletion notification readable, so pageSlug/pageTitle are denormalized at write time
// rather than joined from wiki_pages.
export const wikiNotifications = sqliteTable(
	"wiki_notifications",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		pageId: text("page_id").notNull(),
		pageSlug: text("page_slug").notNull(),
		pageTitle: text("page_title").notNull(),
		action: text("action", { enum: ["created", "updated", "deleted"] }).notNull(),
		actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
		summary: text("summary").notNull(),
		createdAt: integer("created_at").notNull(),
		readAt: integer("read_at"),
	},
	(t) => ({
		userIdx: index("wiki_notifications_user_idx").on(t.workspaceId, t.userId, t.createdAt),
	})
);

// PROJ-495 (R13): per-user scratch draft, one row per (page, user) — saveWikiDraft
// upserts on the unique index below rather than accumulating draft history.
// baseRevisionId is nullable (no FK to wiki_revisions — a revision can itself be
// deleted independently) and carries the same "page had no revisions yet" convention
// as wiki_pages/UpdatePageSchema's baseRevisionId, so publish can hand it straight to
// updateWikiPage's existing optimistic-locking check.
export const wikiDrafts = sqliteTable(
	"wiki_drafts",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		pageId: text("page_id")
			.notNull()
			.references(() => wikiPages.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		content: text("content").notNull(),
		baseRevisionId: text("base_revision_id"),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		userPageUniqueIdx: uniqueIndex("wiki_drafts_user_page_idx").on(
			t.workspaceId,
			t.userId,
			t.pageId
		),
	})
);
