-- 0045: R6 (PROJ-488) — denormalized YAML frontmatter metadata columns on wiki_pages.
--
-- Frontmatter is optional; a page with none has all of these columns null/empty. `type`
-- and `status` are freeform text (not CHECK-constrained) per the PRD — the well-known
-- enum values (runbook|adr|spec|note for type; draft|current|stale|deprecated for status)
-- are enforced at the Zod layer (schemas/wiki.ts) so an invalid value is a structured
-- ValidationError, not a silently-accepted or DB-rejected write. tags/owners are JSON
-- array columns (drizzle `{ mode: "json" }`), matching the existing `issues.labels`
-- JSON-array-column pattern rather than a comma-joined string.
ALTER TABLE wiki_pages ADD COLUMN type TEXT;
ALTER TABLE wiki_pages ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE wiki_pages ADD COLUMN status TEXT;
ALTER TABLE wiki_pages ADD COLUMN verified_at INTEGER;
ALTER TABLE wiki_pages ADD COLUMN verified_by TEXT;
ALTER TABLE wiki_pages ADD COLUMN owners TEXT NOT NULL DEFAULT '[]';
ALTER TABLE wiki_pages ADD COLUMN verify_interval INTEGER;

-- Filtering by type/status is the common R6 access pattern (listWikiPages/searchWiki);
-- tags is JSON so it can't be indexed directly (filtered via a LIKE scan, same tradeoff
-- FTS accepts elsewhere in this schema) but type/status are scalar and worth an index.
CREATE INDEX `wiki_pages_workspace_type_idx` ON `wiki_pages` (`workspace_id`, `type`);
CREATE INDEX `wiki_pages_workspace_status_idx` ON `wiki_pages` (`workspace_id`, `status`);
