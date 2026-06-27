CREATE TABLE agent_sessions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id          TEXT REFERENCES issues(id) ON DELETE SET NULL,
  token_id          TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'agent',
  status            TEXT NOT NULL DEFAULT 'active',
  started_at        INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE INDEX idx_agent_sessions_ws_status ON agent_sessions(workspace_id, status);
CREATE INDEX idx_agent_sessions_issue ON agent_sessions(issue_id);
