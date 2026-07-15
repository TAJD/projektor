-- PROJ-376: human-readable project URL slugs (e.g. "start-line") instead of
-- raw UUIDs. Nullable + a partial unique index (not NOT NULL UNIQUE) so
-- multiple pre-backfill NULLs don't collide; application code generates and
-- dedupes the slug on project creation (services/projects.ts).
ALTER TABLE `projects` ADD COLUMN `slug` text;

-- Backfill existing rows with a basic kebab-case slug derived from the name.
-- Doesn't strip punctuation, so unusual names could still produce an odd
-- slug — acceptable for a one-time backfill. Collisions ARE handled: two
-- projects in the same workspace slugifying to the same base value get a
-- `-2`, `-3`, ... suffix via ROW_NUMBER(), so this can't violate the unique
-- index created below (a single un-deduped UPDATE previously could, and
-- would abort the whole migration on any real workspace with two
-- similarly-named projects).
WITH base AS (
	SELECT
		id,
		lower(replace(replace(trim(name), ' ', '-'), '_', '-')) AS base_slug,
		ROW_NUMBER() OVER (
			PARTITION BY workspace_id, lower(replace(replace(trim(name), ' ', '-'), '_', '-'))
			ORDER BY created_at, id
		) AS rn
	FROM `projects`
)
UPDATE `projects`
SET `slug` = (
	SELECT CASE WHEN base.rn = 1 THEN base.base_slug ELSE base.base_slug || '-' || base.rn END
	FROM base
	WHERE base.id = `projects`.id
)
WHERE `slug` IS NULL;

CREATE UNIQUE INDEX `idx_projects_workspace_slug` ON `projects` (`workspace_id`, `slug`) WHERE `slug` IS NOT NULL;
