-- 0007: FTS5 full-text search index for issues title + body

CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  issue_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  body
);

-- Backfill existing issues
INSERT INTO issues_fts (issue_id, workspace_id, title, body)
SELECT id, workspace_id, title, body FROM issues;
