import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaces } from "./core";
import { agentSessions } from "./agents";

export const agentMessages = sqliteTable(
	"agent_messages",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		scope: text("scope").notNull(),
		agentId: text("agent_id").references(() => agentSessions.id, { onDelete: "set null" }),
		body: text("body").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		scopeIdx: index("idx_agent_messages_scope").on(t.workspaceId, t.scope, t.createdAt),
	})
);
