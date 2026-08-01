-- 0050: R14 (PROJ-496) — wiki trash: soft delete + 30-day retention + undelete + purge.
--
-- `deleted_at` (nullable unix seconds) replaces hard-deleting a wiki_pages row at
-- delete time; NULL means live. Everything a hard delete used to clean up immediately
-- (R2 attachment objects, wiki_links, wiki_watchers, wiki_drafts, wiki_fts rows) now
-- stays in place until purgeExpiredWikiPages (services/wiki.ts) actually removes the
-- row, 30+ days later — see the PR description for the full design-decision writeup.
--
-- The existing (workspace_id, slug) unique index is replaced with a PARTIAL unique
-- index (`WHERE deleted_at IS NULL`) so a slug held by a trashed page becomes
-- available again for a new page immediately — trashing a page is meant to free its
-- slug, not permanently reserve it for 30 days. Undelete re-checks slug availability
-- against live pages only and rejects with a structured conflict if the slug has
-- since been reused (services/wiki.ts#undeleteWikiPage).
ALTER TABLE wiki_pages ADD COLUMN deleted_at integer;

DROP INDEX wiki_pages_workspace_slug_unique_idx;

CREATE UNIQUE INDEX `wiki_pages_workspace_slug_unique_idx` ON `wiki_pages` (`workspace_id`, `slug`) WHERE `deleted_at` IS NULL;

-- Backs both the trash listing (list_wiki_trash) and the purge job's "older than 30
-- days" scan (services/wiki.ts#purgeExpiredWikiPages) — both filter/sort on
-- (workspace_id, deleted_at).
CREATE INDEX `wiki_pages_workspace_deleted_at_idx` ON `wiki_pages` (`workspace_id`, `deleted_at`);
