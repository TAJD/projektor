-- 0043: FTS5 full-text search index for wiki title + content + tags (PROJ-486)
--
-- tags is populated by future R6 work (PROJ-488, frontmatter metadata) — wiki_pages
-- has no tags column yet, so every row is indexed with an empty tags string for now.

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  page_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  content,
  tags
);

-- Backfill existing wiki pages
INSERT INTO wiki_fts (page_id, workspace_id, title, content, tags)
SELECT id, workspace_id, title, content, '' FROM wiki_pages;
