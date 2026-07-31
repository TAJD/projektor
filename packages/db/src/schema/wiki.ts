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
	},
	(t) => ({
		wsSlugIdx: index("wiki_pages_workspace_slug_idx").on(t.workspaceId, t.slug),
		// PROJ-483: enforces slug uniqueness per workspace (0041_wiki_slug_unique.sql).
		wsSlugUniqueIdx: uniqueIndex("wiki_pages_workspace_slug_unique_idx").on(t.workspaceId, t.slug),
		parentIdx: index("wiki_pages_parent_idx").on(t.parentId),
		projectIdx: index("wiki_pages_project_id_idx").on(t.projectId),
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
