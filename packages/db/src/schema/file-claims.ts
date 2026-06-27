import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agentSessions } from "./agents";
import { workspaces } from "./core";
import { issues } from "./issues";

export const issueFileClaims = sqliteTable(
	"issue_file_claims",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		agentId: text("agent_id").references(() => agentSessions.id, { onDelete: "set null" }),
		path: text("path").notNull(),
		claimedAt: integer("claimed_at").notNull(),
		releasedAt: integer("released_at"),
	},
	(t) => ({
		issueIdx: index("idx_file_claims_issue").on(t.workspaceId, t.issueId),
	})
);
