-- PROJ-318: viewer-preserving downgrade for the 0027 all-projects backfill.
--
-- 0027 enrolled every pre-existing member AND viewer into one 'all-projects' group
-- that grants 'member' on every project, silently giving a workspace viewer write
-- access. Grants are group-level, so one user's role can't be lowered in place:
-- split the viewers into their own read-only sibling group that grants 'viewer' on
-- the same projects, then move them out of the member group. Idempotent; only ever
-- touches the deterministic backfilled groups ('grp-allproj-<ws>' and its viewers
-- sibling), never admin-created groups or grants.

-- 1. One read-only sibling group per workspace whose backfilled all-projects group
--    actually contains a viewer.
INSERT OR IGNORE INTO user_groups (id, workspace_id, name, description, created_at)
SELECT 'grp-allproj-viewers-' || w.id, w.id, 'all-projects (viewers)',
       'Migrated: read-only access to all projects that existed before group-based access control.',
       strftime('%s', 'now')
FROM workspaces w
WHERE EXISTS (
  SELECT 1 FROM user_group_members m
  JOIN workspace_members wm ON wm.user_id = m.user_id AND wm.workspace_id = w.id
  WHERE m.group_id = 'grp-allproj-' || w.id AND wm.role = 'viewer'
);

-- 2. Grant viewer on exactly the projects the member all-projects group covers.
INSERT OR IGNORE INTO group_project_grants (group_id, project_id, role)
SELECT 'grp-allproj-viewers-' || w.id, gpg.project_id, 'viewer'
FROM workspaces w
JOIN group_project_grants gpg ON gpg.group_id = 'grp-allproj-' || w.id
WHERE EXISTS (SELECT 1 FROM user_groups vg WHERE vg.id = 'grp-allproj-viewers-' || w.id);

-- 3. Enroll the workspace viewers who were backfilled into the member group.
INSERT OR IGNORE INTO user_group_members (group_id, user_id, added_by, added_at)
SELECT 'grp-allproj-viewers-' || wm.workspace_id, wm.user_id, wm.user_id, strftime('%s', 'now')
FROM workspace_members wm
WHERE wm.role = 'viewer'
  AND EXISTS (SELECT 1 FROM user_groups vg WHERE vg.id = 'grp-allproj-viewers-' || wm.workspace_id)
  AND EXISTS (SELECT 1 FROM user_group_members m
              WHERE m.group_id = 'grp-allproj-' || wm.workspace_id AND m.user_id = wm.user_id);

-- 4. Remove those viewers from the member all-projects group, but only once they are
--    safely in the read-only group (so re-runs and partial states never orphan them).
DELETE FROM user_group_members
WHERE group_id LIKE 'grp-allproj-%'
  AND group_id NOT LIKE 'grp-allproj-viewers-%'
  AND EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.user_id = user_group_members.user_id
      AND wm.workspace_id = substr(user_group_members.group_id, 13)
      AND wm.role = 'viewer'
  )
  AND EXISTS (
    SELECT 1 FROM user_group_members vm
    WHERE vm.user_id = user_group_members.user_id
      AND vm.group_id = 'grp-allproj-viewers-' || substr(user_group_members.group_id, 13)
  );
