import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	createdAt: integer("created_at").notNull(),
});

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	name: text("name").notNull(),
	avatarUrl: text("avatar_url"),
	createdAt: integer("created_at").notNull(),
});

export const workspaceMembers = sqliteTable(
	"workspace_members",
	{
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
			.notNull()
			.default("member"),
		joinedAt: integer("joined_at").notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
	})
);

export const apiTokens = sqliteTable("api_tokens", {
	id: text("id").primaryKey(),
	// NULL = user-scoped token (valid across all workspaces the user is a member of)
	workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
	userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
	name: text("name").notNull(),
	tokenHash: text("token_hash").notNull().unique(),
	scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
	lastUsedAt: integer("last_used_at"),
	expiresAt: integer("expires_at"),
	createdAt: integer("created_at").notNull(),
});

export const enabledPlugins = sqliteTable(
	"enabled_plugins",
	{
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		pluginId: text("plugin_id").notNull(),
		config: text("config", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.$defaultFn(() => ({})),
		enabledAt: integer("enabled_at").notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.workspaceId, t.pluginId] }),
	})
);
