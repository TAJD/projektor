CREATE VIRTUAL TABLE wiki_fts_new USING fts5(
  page_id UNINDEXED,
  workspace_id,
  title,
  content,
  tags
);
INSERT INTO wiki_fts_new (rowid, page_id, workspace_id, title, content, tags)
SELECT rowid, page_id, workspace_id, title, content, tags FROM wiki_fts;
DROP TABLE wiki_fts;
ALTER TABLE wiki_fts_new RENAME TO wiki_fts;
PRAGMA optimize;
