-- PROJ-376: human-readable project URL slugs (e.g. "start-line") instead of
-- raw UUIDs. Nullable + a partial unique index (not NOT NULL UNIQUE) so
-- multiple pre-backfill NULLs don't collide; application code generates and
-- dedupes the slug on project creation (services/projects.ts).
ALTER TABLE `projects` ADD COLUMN `slug` text;
CREATE UNIQUE INDEX `idx_projects_workspace_slug` ON `projects` (`workspace_id`, `slug`) WHERE `slug` IS NOT NULL;

-- Backfill existing rows with a basic kebab-case slug derived from the name.
-- Good enough for names made of plain words/spaces (all current projects);
-- doesn't strip punctuation, so a name with special characters could still
-- collide or produce an odd slug — acceptable for a one-time backfill.
UPDATE `projects`
SET `slug` = lower(replace(replace(trim(`name`), ' ', '-'), '_', '-'))
WHERE `slug` IS NULL;
