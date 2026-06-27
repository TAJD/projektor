-- Seed default task types for workspaces that have no task types yet (idempotent via INSERT OR IGNORE on workspace+key unique index)
INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'epic', 'Epic', NULL, NULL, 1, 0
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id);

INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'story', 'Story', NULL, NULL, 2, 0
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id);

INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'task', 'Task', NULL, NULL, 3, 1
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id);

INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'bug', 'Bug', NULL, NULL, 4, 0
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id);

-- Backfill type_id for existing issues that have no type set
UPDATE issues
SET type_id = (SELECT id FROM task_types WHERE workspace_id = issues.workspace_id AND key = 'task' LIMIT 1)
WHERE type_id IS NULL
  AND EXISTS (SELECT 1 FROM task_types WHERE workspace_id = issues.workspace_id AND key = 'task');
