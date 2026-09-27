-- PROJ-849: task_statuses.category could change (update_task_status) without
-- issues.status_category being re-synced for issues already on that status — that
-- gap is now closed on the write path, but existing rows may already have drifted.
-- Repair every issue whose status_id points at a task_statuses row (workspace-scoped,
-- so a status_id can never resolve against another workspace's status) with a
-- different category than what's currently stored.
UPDATE issues
SET status_category = (
  SELECT ts.category FROM task_statuses ts
  WHERE ts.id = issues.status_id AND ts.workspace_id = issues.workspace_id
)
WHERE status_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM task_statuses ts
    WHERE ts.id = issues.status_id AND ts.workspace_id = issues.workspace_id
      AND ts.category <> COALESCE(issues.status_category, '')
  );
