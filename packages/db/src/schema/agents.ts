import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { apiTokens, workspaces } from "./core";
import { issues } from "./issues";

export const agentSessions = sqliteTable(
	"agent_sessions",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
		tokenId: text("token_id").references(() => apiTokens.id, { onDelete: "set null" }),
		name: text("name").notNull(),
		kind: text("kind", { enum: ["agent", "human"] })
			.notNull()
			.default("agent"),
		status: text("status", { enum: ["active", "ended"] })
			.notNull()
			.default("active"),
		startedAt: integer("started_at").notNull(),
		lastHeartbeatAt: integer("last_heartbeat_at").notNull(),
		endedAt: integer("ended_at"),
	},
	(t) => ({
		wsStatusIdx: index("idx_agent_sessions_ws_status").on(t.workspaceId, t.status),
		issueIdx: index("idx_agent_sessions_issue").on(t.issueId),
	})
);
