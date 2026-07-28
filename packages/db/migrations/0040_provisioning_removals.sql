-- PROJ-436: removeMember only deleted the workspace_members row, but provisioning
-- (ensureUserProvisioned in services/provisioning.ts) re-derives membership from config on
-- every unprovisioned run — ADMIN_EMAILS, AUTO_JOIN_ROLE, WORKSPACE_DOMAIN_MAP — so a removed
-- user who matches any of those was silently re-added once their provisioning cache expired.
-- This tombstones an explicit removal so provisioning can skip re-adding that (workspace,
-- user) pair; re-inviting the user to the same workspace clears it (see inviteMember).
CREATE TABLE provisioning_removals (
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	removed_at INTEGER NOT NULL,
	PRIMARY KEY (workspace_id, user_id)
);
