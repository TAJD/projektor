ALTER TABLE issues ADD COLUMN status_category TEXT NOT NULL DEFAULT '';
CREATE INDEX issues_workspace_category_created_idx ON issues (workspace_id, status_category, created_at DESC);
UPDATE issues SET status_category = COALESCE((SELECT category FROM task_statuses WHERE id = issues.status_id), '');
