-- PROJ-816: wiki_fts rows were deleted with `WHERE page_id = ?`, but page_id is an
-- UNINDEXED FTS5 column, so every page save scanned the whole index (every tenant's
-- pages). Key each FTS row by an integer rowid stored on the page instead
-- (wiki_pages.search_rowid) so a re-index deletes by rowid: a direct lookup whose cost
-- doesn't grow with the corpus.
--
-- search_rowid is backfilled from the page's own SQLite rowid (unique); pages created
-- afterwards get a random 52-bit id from the app (services/wiki.ts#newSearchRowid).
ALTER TABLE wiki_pages ADD COLUMN search_rowid INTEGER;
UPDATE wiki_pages SET search_rowid = rowid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_pages_search_rowid ON wiki_pages(search_rowid);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts_new USING fts5(
  page_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  content,
  tags
);
-- One FTS row per page: if the old index held duplicates for a page, keep the most
-- recently inserted one (highest rowid), which is the latest re-index.
INSERT INTO wiki_fts_new (rowid, page_id, workspace_id, title, content, tags)
SELECT p.search_rowid, f.page_id, f.workspace_id, f.title, f.content, f.tags
FROM wiki_fts f JOIN wiki_pages p ON p.id = f.page_id
WHERE f.rowid IN (SELECT MAX(rowid) FROM wiki_fts GROUP BY page_id);
DROP TABLE wiki_fts;
ALTER TABLE wiki_fts_new RENAME TO wiki_fts;
PRAGMA optimize;
