-- 0044: server-side wiki link graph (PROJ-485)
--
-- Recomputed (delete-then-reinsert) on every wiki page content write —
-- services/wiki-links.ts#reindexWikiLinks. target_page_id is nullable: null means
-- the [[Target]]/URL link's title/slug didn't resolve to a page in the workspace at
-- write time (broken link). target_title always holds the raw parsed text, even when
-- resolved, so it survives a later rename of the target page (id-backed) and remains
-- available for broken-link reporting/re-resolution.
--
-- target_page_id uses ON DELETE SET NULL rather than CASCADE: deleting the target page
-- should turn outgoing links to it into broken links (still visible via target_title),
-- not silently vanish the link row. source_page_id uses ON DELETE CASCADE since a
-- source page's outgoing links have no meaning once the source itself is gone (mirrors
-- the delete-then-reinsert reindex pattern — the row set is owned by the source page).

CREATE TABLE `wiki_links` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`source_page_id` text NOT NULL REFERENCES `wiki_pages`(`id`) ON DELETE CASCADE,
	`target_page_id` text REFERENCES `wiki_pages`(`id`) ON DELETE SET NULL,
	`target_title` text NOT NULL,
	`created_at` integer NOT NULL
);

CREATE INDEX `wiki_links_source_page_idx` ON `wiki_links` (`source_page_id`);
-- Backlinks lookup (get_backlinks) and broken-link reporting (target_page_id IS NULL)
-- both filter by workspace_id + target_page_id.
CREATE INDEX `wiki_links_workspace_target_idx` ON `wiki_links` (`workspace_id`, `target_page_id`);
