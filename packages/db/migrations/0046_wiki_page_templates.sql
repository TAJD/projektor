-- 0046: R9 (PROJ-491) — denormalized `template: true` frontmatter flag on wiki_pages.
--
-- Same denormalize-frontmatter-into-a-column pattern as 0045_wiki_frontmatter.sql:
-- the boolean lives in the page's YAML frontmatter (services/wiki-frontmatter.ts) and
-- is mirrored here purely so search/listing/staleness queries can filter/exclude on it
-- without parsing every page's content. Defaults to false — a page with no frontmatter
-- (or no `template` key) is never a template.
ALTER TABLE wiki_pages ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;

-- search_wiki/list_stale_pages exclude is_template=1 pages by default (R9); the template
-- picker (list_wiki_templates) queries is_template=1 directly. Both filter by workspace
-- first, so index on (workspace_id, is_template) rather than is_template alone.
CREATE INDEX `wiki_pages_workspace_template_idx` ON `wiki_pages` (`workspace_id`, `is_template`);
