CREATE TABLE issue_file_claims (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id      TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  path          TEXT NOT NULL,
  claimed_at    INTEGER NOT NULL,
  released_at   INTEGER
);
CREATE UNIQUE INDEX idx_file_claims_active
  ON issue_file_claims(workspace_id, path) WHERE released_at IS NULL;
CREATE INDEX idx_file_claims_issue ON issue_file_claims(workspace_id, issue_id);
