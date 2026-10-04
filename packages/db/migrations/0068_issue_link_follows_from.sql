-- PROJ-961: add the directed 'follows_from' link type (source = the follow-up issue,
-- target = the issue it continues). SQLite can't alter a CHECK constraint, so rebuild
-- issue_links; nothing references it by FK.
CREATE TABLE issue_links_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('blocks', 'relates_to', 'duplicates', 'follows_from')),
  created_by_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

INSERT INTO issue_links_new (id, workspace_id, source_issue_id, target_issue_id, type, created_by_id, created_at)
  SELECT id, workspace_id, source_issue_id, target_issue_id, type, created_by_id, created_at FROM issue_links;

DROP TABLE issue_links;
ALTER TABLE issue_links_new RENAME TO issue_links;

CREATE INDEX IF NOT EXISTS issue_links_source_idx ON issue_links(source_issue_id);
CREATE INDEX IF NOT EXISTS issue_links_target_idx ON issue_links(target_issue_id);

PRAGMA optimize;
