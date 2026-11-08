CREATE INDEX IF NOT EXISTS idx_issues_open_by_workspace ON issues(workspace_id)
WHERE COALESCE(NULLIF(status_category, ''), status) NOT IN ('done','cancelled');
PRAGMA optimize;
