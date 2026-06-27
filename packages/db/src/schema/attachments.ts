import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users, workspaces } from "./core";

export const attachments = sqliteTable(
	"attachments",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		r2Key: text("r2_key").notNull(),
		filename: text("filename").notNull(),
		contentType: text("content_type").notNull(),
		size: integer("size").notNull(),
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
