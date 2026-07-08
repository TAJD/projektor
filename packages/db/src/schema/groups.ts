import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users, workspaces } from "./core";
import { projects } from "./issues";

// PROJ-311: admin-managed groups that carry per-project access grants.
export const userGroups = sqliteTable(
	"user_groups",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		wsNameIdx: uniqueIndex("user_groups_workspace_name_idx").on(t.workspaceId, t.name),
	})
);

export const userGroupMembers = sqliteTable(
	"user_group_members",
	{
		groupId: text("group_id")
			.notNull()
			.references(() => userGroups.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		addedBy: text("added_by")
			.notNull()
			.references(() => users.id),
		addedAt: integer("added_at").notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.groupId, t.userId] }),
		userIdx: index("user_group_members_user_idx").on(t.userId),
	})
);

export const groupProjectGrants = sqliteTable(
	"group_project_grants",
	{
		groupId: text("group_id")
			.notNull()
			.references(() => userGroups.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["viewer", "member", "admin"] }).notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.groupId, t.projectId] }),
		projectIdx: index("group_project_grants_project_idx").on(t.projectId),
	})
);
