CREATE TABLE agent_messages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  agent_id      TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_agent_messages_scope ON agent_messages(workspace_id, scope, created_at);
