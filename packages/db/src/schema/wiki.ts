import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
		authorId: text("author_id")
			.notNull()
			.references(() => users.id),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		pageIdx: index("wiki_revisions_page_idx").on(t.pageId),
	})
);
