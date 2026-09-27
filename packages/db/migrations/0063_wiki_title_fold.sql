-- PROJ-818: wiki link titles are matched case-insensitively, but SQLite's lower() only
-- folds ASCII, so [[Über uns]] never matched a page titled "über uns" (JS lowercases
-- both). Store the fold computed in JS (services/wiki-links.ts#foldWikiTitle) next to
-- the title on both sides of the match, and compare those instead.
--
-- ASCII-only values are backfilled here (lower() is exact for them). Rows with any
-- non-ASCII character are left NULL and filled in by the app, which heals NULL folds in
-- bounded batches before resolving titles (healTitleFolds) and in backfill_wiki_links.
ALTER TABLE wiki_pages ADD COLUMN title_fold TEXT;
ALTER TABLE wiki_links ADD COLUMN target_fold TEXT;
-- The link target exactly as written (title text, or the slug for URL links). The
-- broken-links report shows it for links whose target the caller can't see, instead of
-- target_title (which, for a slug link, is the resolved page's title).
ALTER TABLE wiki_links ADD COLUMN target_text TEXT;
UPDATE wiki_pages SET title_fold = lower(title) WHERE title NOT GLOB '*[^ -~]*';
UPDATE wiki_links SET target_fold = lower(target_title) WHERE target_title NOT GLOB '*[^ -~]*';
CREATE INDEX IF NOT EXISTS idx_wiki_pages_ws_title_fold ON wiki_pages(workspace_id, title_fold);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_title_fold_null ON wiki_pages(workspace_id) WHERE title_fold IS NULL;
CREATE INDEX IF NOT EXISTS idx_wiki_links_ws_target_fold ON wiki_links(workspace_id, target_fold);
CREATE INDEX IF NOT EXISTS idx_wiki_links_target_fold_null ON wiki_links(workspace_id) WHERE target_fold IS NULL;
PRAGMA optimize;
