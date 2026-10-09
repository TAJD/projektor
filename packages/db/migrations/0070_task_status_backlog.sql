ALTER TABLE task_statuses ADD COLUMN is_backlog INTEGER NOT NULL DEFAULT 0;
UPDATE task_statuses SET is_backlog = 1 WHERE key = 'backlog';
