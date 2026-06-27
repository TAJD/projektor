import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaces } from "./core";
import { projects } from "./issues";

export const sprints = sqliteTable(
	"sprints",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		goal: text("goal"),
		status: text("status", { enum: ["planned", "active", "completed"] })
			.notNull()
			.default("planned"),
		startDate: integer("start_date"),
		endDate: integer("end_date"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		wsProjectIdx: index("sprints_workspace_project_idx").on(t.workspaceId, t.projectId),
	})
);
