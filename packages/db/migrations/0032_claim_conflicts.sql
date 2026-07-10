-- Claim conflicts (PROJ-337, design: docs/design/proj-333-claim-contention.md): an event
-- log of rejected/overridden claimFiles attempts. assertNoConflicts pre-checks and
-- rejects all-or-nothing before any insert into issue_file_claims, so a rejected attempt
-- leaves no row for any overlap-derivation approach to find — this table records the
-- attempt directly, at the point it's already resolved in-process.
CREATE TABLE claim_conflicts (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	rejected_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
	rejected_agent_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
	holding_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
	holding_agent_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
	forced INTEGER NOT NULL DEFAULT 0, -- 1 when this was an override (force: true), not a hard rejection
	occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_claim_conflicts_workspace_occurred ON claim_conflicts(workspace_id, occurred_at);
CREATE INDEX idx_claim_conflicts_path ON claim_conflicts(workspace_id, path);
