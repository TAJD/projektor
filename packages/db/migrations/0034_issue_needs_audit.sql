-- PROJ-375: agents can close issues to done directly (no gate blocks it); this
-- flags agent-initiated closures whose completion-report verification wasn't
-- externally checkable (no CI run/PR/commit link) for after-the-fact human review.
ALTER TABLE `issues` ADD COLUMN `needs_audit` integer DEFAULT false NOT NULL;
CREATE INDEX `idx_issues_workspace_needs_audit` ON `issues` (`workspace_id`,`needs_audit`);
