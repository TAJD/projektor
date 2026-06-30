-- Track when an issue was marked completed, for date-range filtering (PROJ-212).
-- completed_at is stamped when an issue first enters a done-category status and
-- cleared when it leaves (see updateIssue). An indexed column keeps "completed
-- between X and Y" an index range scan rather than a derive-on-read over the
-- activity log, so it stays scalable as history grows.
ALTER TABLE issues ADD COLUMN completed_at INTEGER;

-- Best-effort backfill for issues already done: use updated_at as an approximate
-- completion time. Imperfect (a later edit moved updated_at), but lets historical
-- done issues participate in completed-date filters immediately.
UPDATE issues SET completed_at = updated_at
  WHERE status_category = 'done' OR status = 'done';

CREATE INDEX idx_issues_workspace_completed ON issues(workspace_id, completed_at);
