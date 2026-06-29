-- Atomic issue leasing for parallel agents (PROJ-184).
-- A lease binds an issue to an agent session. It is "live" while released_at IS
-- NULL *and* its owning agent_session is live (active + heartbeat within TTL);
-- liveness is derived from the session, so a dead session's lease expires with
-- no background job. The partial UNIQUE index is the atomicity guard: at most
-- one active lease can exist per issue, so concurrent claims can't both win.
CREATE TABLE issue_leases (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id          TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  agent_session_id  TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  claimed_at        INTEGER NOT NULL,
  released_at       INTEGER,
  release_reason    TEXT
);
CREATE UNIQUE INDEX idx_issue_leases_active
  ON issue_leases(workspace_id, issue_id) WHERE released_at IS NULL;
CREATE INDEX idx_issue_leases_agent ON issue_leases(workspace_id, agent_session_id);
