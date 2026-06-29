import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agentSessions } from "./agents";
import { workspaces } from "./core";
import { issues } from "./issues";

// Issue leases (PROJ-184). The partial UNIQUE index that enforces "one active
// lease per issue" lives in the raw migration (0021) — Drizzle can't express a
// partial index — so only the non-partial agent lookup index is declared here.
export const issueLeases = sqliteTable(
	"issue_leases",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		agentSessionId: text("agent_session_id")
			.notNull()
			.references(() => agentSessions.id, { onDelete: "cascade" }),
		claimedAt: integer("claimed_at").notNull(),
		releasedAt: integer("released_at"),
		releaseReason: text("release_reason"),
	},
	(t) => ({
		agentIdx: index("idx_issue_leases_agent").on(t.workspaceId, t.agentSessionId),
	})
);
