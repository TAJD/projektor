CREATE INDEX IF NOT EXISTS idx_issues_ws_project_status ON issues(workspace_id, project_id, status);
PRAGMA optimize;
