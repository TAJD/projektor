-- PROJ-483: dedupe existing (workspace_id, slug) collisions in wiki_pages before
-- adding a uniqueness constraint. There is a known live collision (two "Operations"
-- pages both holding slug `operations`). The oldest page (by created_at, id) keeps
-- its slug as-is; newer duplicates get a numeric suffix appended via ROW_NUMBER(),
-- e.g. `operations` -> `operations-2`, `operations-3`, ... This mirrors the
-- 0035_project_slug.sql dedup pattern for project slugs.
WITH ranked AS (
	SELECT
		id,
		ROW_NUMBER() OVER (
			PARTITION BY workspace_id, slug
			ORDER BY created_at, id
		) AS rn
	FROM wiki_pages
)
UPDATE wiki_pages
SET slug = wiki_pages.slug || '-' || (SELECT rn FROM ranked WHERE ranked.id = wiki_pages.id)
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX `wiki_pages_workspace_slug_unique_idx` ON `wiki_pages` (`workspace_id`, `slug`);

-- PROJ-483: old slug -> page id, written whenever a page's slug changes via update
-- (services/wiki.ts). Lookup order when resolving a slug: check for a live page
-- with that slug first, then fall back to this table. Redirects always point at the
-- page's id (never at another slug), so a page renamed multiple times never needs
-- its earlier redirect rows updated — every old slug already resolves directly to
-- the current row, and chains of redirect -> redirect can't form.
CREATE TABLE `wiki_redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`old_slug` text NOT NULL,
	`page_id` text NOT NULL REFERENCES `wiki_pages`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL
);

CREATE UNIQUE INDEX `wiki_redirects_workspace_old_slug_idx` ON `wiki_redirects` (`workspace_id`, `old_slug`);
CREATE INDEX `wiki_redirects_page_id_idx` ON `wiki_redirects` (`page_id`);
