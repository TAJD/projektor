-- PROJ-857: indexes for the hot issue/lease/attachment/rate-limit/revision queries
-- found in the 2026-09 performance review (EXPLAIN QUERY PLAN on a 5k-issue seed).
--
-- Issue lists order by (created_at DESC, id DESC) — id is the cursor tiebreak for
-- rows created in the same second — so both list indexes end with id.
CREATE INDEX IF NOT EXISTS idx_issues_ws_project_created ON issues(workspace_id, project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_issues_ws_created ON issues(workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id);
-- get_issue by ref (PROJ-42) resolves projects.key within a workspace. Not UNIQUE: the
-- service already rejects duplicate keys, and a UNIQUE index would fail this migration
-- outright on any instance that somehow holds a duplicate, blocking the deploy.
CREATE INDEX IF NOT EXISTS idx_projects_ws_key ON projects(workspace_id, key);
CREATE INDEX IF NOT EXISTS idx_issue_leases_issue ON issue_leases(issue_id);
CREATE INDEX IF NOT EXISTS idx_attachments_linked_wiki_page ON attachments(linked_wiki_page_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_window_start ON rate_limit(window_start);
CREATE INDEX IF NOT EXISTS idx_wiki_revisions_page_created ON wiki_revisions(page_id, created_at);

-- Without statistics the planner picks idx_issues_workspace_needs_audit even for
-- project-scoped lists. Convention: every migration that adds an index ends with this.
PRAGMA optimize;
