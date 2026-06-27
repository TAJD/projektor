-- PROJ-91: make api_tokens.workspace_id nullable (NULL = user-scoped token)
-- SQLite cannot drop NOT NULL in place; rebuild the table.
CREATE TABLE api_tokens_new (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT,
  user_id TEXT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE set null
);

INSERT INTO api_tokens_new SELECT * FROM api_tokens;
DROP TABLE api_tokens;
ALTER TABLE api_tokens_new RENAME TO api_tokens;
