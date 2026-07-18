import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users, workspaces } from "./core";
import { wikiPages } from "./wiki";

export const attachments = sqliteTable(
	"attachments",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		// "file" = uploaded to R2 (r2Key/contentType/size populated); "wiki_ref" = reference to a
		// wiki page (linkedWikiPageId populated); "url" = external link (url populated, filename
		// holds the optional display label). Unused columns for a given kind are "" / 0, not null,
		// since D1/SQLite can't cheaply relax NOT NULL on existing columns via ALTER TABLE.
		kind: text("kind", { enum: ["file", "wiki_ref", "url"] })
			.notNull()
			.default("file"),
		r2Key: text("r2_key").notNull(),
		filename: text("filename").notNull(),
		contentType: text("content_type").notNull(),
		size: integer("size").notNull(),
		url: text("url"),
		linkedWikiPageId: text("linked_wiki_page_id").references(() => wikiPages.id, {
			onDelete: "cascade",
		}),
		entityType: text("entity_type", { enum: ["issue", "wiki_page"] }).notNull(),
		entityId: text("entity_id").notNull(),
		createdById: text("created_by_id")
			.notNull()
			.references(() => users.id),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		wsEntityIdx: index("attachments_workspace_entity_idx").on(
			t.workspaceId,
			t.entityType,
			t.entityId
		),
	})
);
