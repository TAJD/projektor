-- PROJ-894: record which credential registered an agent session, so an omitted agentId
-- can resolve to "the one live session this credential owns" without any server-side
-- connection state. agent_sessions.token_id was always written as NULL and is an FK to
-- api_tokens, so it can't hold an OAuth grant id; credential_id is deliberately a plain
-- TEXT column (pk/pat token id or OAuth grant id) with no FK, alongside the auth method
-- that says which table the id belongs to. Existing rows stay NULL: a NULL credential
-- never auto-resolves, it just requires an explicit agentId as before.
ALTER TABLE agent_sessions ADD COLUMN auth_method TEXT;
ALTER TABLE agent_sessions ADD COLUMN credential_id TEXT;

CREATE INDEX idx_agent_sessions_credential ON agent_sessions(workspace_id, credential_id, status);

PRAGMA optimize;
