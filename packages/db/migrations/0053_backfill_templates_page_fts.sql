-- 0053: PROJ-522 — 0047_seed_wiki_templates.sql inserted the seeded "Templates" parent
-- page ('page-templates') into wiki_pages only, never wiki_fts (app-maintained, not
-- trigger-based — see 0043_wiki_fts.sql). The three template pages themselves are
-- correctly search-excluded (is_template=1), but the parent page is a real browsable,
-- non-template page and was invisible to search_wiki until someone happened to edit it.
-- Guarded by NOT EXISTS so it's safe to re-run and a no-op for any workspace whose parent
-- page was already reindexed by a subsequent edit.
INSERT INTO wiki_fts (page_id, workspace_id, title, content, tags)
SELECT p.id, p.workspace_id, p.title, p.content, ''
FROM wiki_pages p
WHERE p.slug = 'page-templates'
  AND NOT EXISTS (SELECT 1 FROM wiki_fts f WHERE f.page_id = p.id);
