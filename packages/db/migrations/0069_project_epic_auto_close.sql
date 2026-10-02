-- PROJ-962: per-project choice for what happens when the last child of an epic is
-- closed (done/cancelled). 0 (default) = update_issue returns a parentReadyToClose hint;
-- 1 = the epic is closed automatically.
ALTER TABLE projects ADD COLUMN epic_auto_close INTEGER NOT NULL DEFAULT 0;

PRAGMA optimize;
