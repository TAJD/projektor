ALTER TABLE issues ADD COLUMN search_rowid INTEGER;
UPDATE issues SET search_rowid = rowid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_search_rowid ON issues(search_rowid);

CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts_new USING fts5(
  issue_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  body
);
INSERT INTO issues_fts_new (rowid, issue_id, workspace_id, title, body)
SELECT i.search_rowid, f.issue_id, f.workspace_id, f.title, f.body
FROM issues_fts f JOIN issues i ON i.id = f.issue_id
WHERE f.rowid IN (SELECT MAX(rowid) FROM issues_fts GROUP BY issue_id);
DROP TABLE issues_fts;
ALTER TABLE issues_fts_new RENAME TO issues_fts;
PRAGMA optimize;
