-- WIP-cap pressure (PROJ-342): claimIssue in services/issue-leases.ts throws a
-- ConflictError when the per-project agent WIP cap is hit (services/issue-leases.ts,
-- fetchAgentWipCap/claimIssue), but recorded nothing — no event, no counter. This is an
-- event log of those denials, following the issue_gate_rejections (0031) / claim_conflicts
-- (0032) pattern: the denial is resolved in-process (no row otherwise exists to derive it
-- from), so it's recorded directly at the rejection site.
CREATE TABLE wip_cap_denials (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
	agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
	occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_wip_cap_denials_workspace_occurred ON wip_cap_denials(workspace_id, occurred_at);
CREATE INDEX idx_wip_cap_denials_project ON wip_cap_denials(workspace_id, project_id);
