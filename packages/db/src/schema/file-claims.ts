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
		// PROJ-334: distinguishes a deliberate release (completion) from an abandoned
		// claim (agent session ended without releasing). NULL for claims released
		// before this column existed, and for still-active claims.
		releaseReason: text("release_reason"),
	},
	(t) => ({
		issueIdx: index("idx_file_claims_issue").on(t.workspaceId, t.issueId),
	})
);

// PROJ-337: claim conflicts — an event log of rejected/overridden claimFiles attempts.
// assertNoConflicts pre-checks and rejects all-or-nothing before any insert into
// issue_file_claims, so a rejected attempt leaves no row to derive overlap from; this
// records the attempt directly. `forced` distinguishes a hard rejection (force: false)
// from an override (force: true, an existing claim was evicted).
export const claimConflicts = sqliteTable(
	"claim_conflicts",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		rejectedIssueId: text("rejected_issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		rejectedAgentId: text("rejected_agent_id").references(() => agentSessions.id, {
			onDelete: "set null",
		}),
		holdingIssueId: text("holding_issue_id")
			.notNull()
			.references(() => issues.id, { onDelete: "cascade" }),
		holdingAgentId: text("holding_agent_id").references(() => agentSessions.id, {
			onDelete: "set null",
		}),
		forced: integer("forced").notNull().default(0),
		occurredAt: integer("occurred_at").notNull(),
	},
	(t) => ({
		wsOccurredIdx: index("idx_claim_conflicts_workspace_occurred").on(t.workspaceId, t.occurredAt),
		pathIdx: index("idx_claim_conflicts_path").on(t.workspaceId, t.path),
	})
);
