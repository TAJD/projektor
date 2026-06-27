import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaces } from "./core";
import { issues, projects } from "./issues";

export const customFieldDefinitions = sqliteTable(
	"custom_field_definitions",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		label: text("label").notNull(),
		type: text("type", { enum: ["text", "number", "select", "date", "user"] }).notNull(),
		options: text("options"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		wsIdx: index("cfd_workspace_idx").on(t.workspaceId),
		wsProjKeyIdx: index("cfd_ws_proj_key_idx").on(t.workspaceId, t.projectId, t.key),
	})
);

export const customFieldValues = sqliteTable(
	"custom_field_values",
	{
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		fieldId: text("field_id")
			.notNull()
			.references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
		value: text("value").notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.issueId, t.fieldId] }),
		fieldIdx: index("cfv_field_idx").on(t.fieldId),
	})
);
