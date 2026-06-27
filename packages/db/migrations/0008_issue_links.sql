CREATE TABLE IF NOT EXISTS issue_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('blocks', 'relates_to', 'duplicates')),
  created_by_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS issue_links_source_idx ON issue_links(source_issue_id);
CREATE INDEX IF NOT EXISTS issue_links_target_idx ON issue_links(target_issue_id);
