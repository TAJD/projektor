-- PROJ-311: group-based project access.
-- Authorization moves from workspace-level only to per-project grants held by
-- admin-managed groups. Default-deny: a non-admin member sees a project only if
-- one of their groups holds a grant on it. Workspace owner/admin bypass groups.

CREATE TABLE user_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX user_groups_workspace_name_idx ON user_groups (workspace_id, name);

CREATE TABLE user_group_members (
  group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL REFERENCES users(id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
-- Entry point for the per-request visibility join (user -> groups -> grants).
CREATE INDEX user_group_members_user_idx ON user_group_members (user_id);

CREATE TABLE group_project_grants (
  group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','member','admin')),
  PRIMARY KEY (group_id, project_id)
);
CREATE INDEX group_project_grants_project_idx ON group_project_grants (project_id);

-- Migration backfill: default-deny would blank out every existing non-admin
-- member. Preserve their current visibility by creating one `all-projects` group
-- per workspace (only where projects exist), granting `member` on every existing
-- project, and enrolling all existing non-owner/non-admin members. New users after
-- this migration get the default-deny pending flow instead.
INSERT INTO user_groups (id, workspace_id, name, description, created_at)
SELECT 'grp-allproj-' || w.id, w.id, 'all-projects',
       'Migrated: preserves access to all projects that existed before group-based access control.',
       strftime('%s', 'now')
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM projects p WHERE p.workspace_id = w.id);

INSERT INTO group_project_grants (group_id, project_id, role)
SELECT 'grp-allproj-' || p.workspace_id, p.id, 'member'
FROM projects p;

INSERT INTO user_group_members (group_id, user_id, added_by, added_at)
SELECT 'grp-allproj-' || wm.workspace_id, wm.user_id, wm.user_id, strftime('%s', 'now')
FROM workspace_members wm
WHERE wm.role IN ('member', 'viewer')
  AND EXISTS (SELECT 1 FROM user_groups g WHERE g.id = 'grp-allproj-' || wm.workspace_id);
