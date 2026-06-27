-- PROJ-137: fix missing default task types
-- Migration 0012 used a blanket NOT EXISTS check (any task type for the workspace),
-- so after 'epic' was inserted for an empty workspace the remaining three were skipped,
-- and workspaces with custom types but no 'epic' got nothing at all.
-- This migration uses per-key checks so each type is inserted only when missing.
INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'epic', 'Epic', NULL, NULL, 1, 0
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id AND key = 'epic');

INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'story', 'Story', NULL, NULL, 2, 0
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id AND key = 'story');

INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'task', 'Task', NULL, NULL, 3, 0
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id AND key = 'task');

INSERT OR IGNORE INTO task_types (id, workspace_id, key, name, color, icon, position, is_default)
SELECT lower(hex(randomblob(16))), w.id, 'bug', 'Bug', NULL, NULL, 4, 0
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM task_types WHERE workspace_id = w.id AND key = 'bug');
