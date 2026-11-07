CREATE INDEX IF NOT EXISTS idx_issues_dor_ready_null ON issues(workspace_id) WHERE dor_ready IS NULL;
PRAGMA optimize;
