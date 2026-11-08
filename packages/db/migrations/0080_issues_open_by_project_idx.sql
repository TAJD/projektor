CREATE INDEX IF NOT EXISTS idx_issues_open_by_project ON issues(project_id, status_id, status, status_category)
WHERE COALESCE(NULLIF(status_category, ''), status) NOT IN ('done','cancelled');
PRAGMA optimize;
