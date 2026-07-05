-- Flow metrics (PROJ-252): indexed, write-once timestamps for lead/cycle time.
-- Unlike completed_at (0022), which is cleared if an issue leaves 'done' so
-- "currently completed" filters stay correct, these three are stamped the
-- FIRST time an issue enters the corresponding state and are never cleared —
-- reopening and redoing an issue is real rework and should still count.
ALTER TABLE issues ADD COLUMN ready_at INTEGER;
ALTER TABLE issues ADD COLUMN claimed_at INTEGER;
ALTER TABLE issues ADD COLUMN done_at INTEGER;

CREATE INDEX idx_issues_workspace_ready_at ON issues(workspace_id, ready_at);
CREATE INDEX idx_issues_workspace_claimed_at ON issues(workspace_id, claimed_at);
CREATE INDEX idx_issues_workspace_done_at ON issues(workspace_id, done_at);
