-- PROJ-811: RESERVED_WIKI_SLUGS (apps/api/src/services/wiki.ts) now covers every fixed
-- route under /api/wiki. A page that already had one of those slugs was shadowed by the
-- route and could never load, so it is renamed here: `<slug>-page`, or, if a live page
-- already holds that, `<slug>-page-<first 8 chars of id>`.
--
-- Trashed rows are renamed too, so they can still be restored (undelete re-checks the
-- slug against the reserved list). No wiki_redirects row is added for the old slug: a
-- request for it hits the fixed route before any redirect lookup, so it would be dead.
--
-- Keep this list in sync with RESERVED_WIKI_SLUGS at the time of writing; later
-- additions need their own migration.

-- Pass 1: take `<slug>-page` where no live page in the workspace already has it.
UPDATE wiki_pages
SET slug = slug || '-page', version = version + 1
WHERE slug IN (
	'view', 'index', 'templates', 'tree', 'search', 'broken-links', 'stale-pages',
	'backfill-links', 'watches', 'notifications', 'trash', 'purge-trash', 'changes', 'export'
)
AND NOT EXISTS (
	SELECT 1 FROM wiki_pages other
	WHERE other.workspace_id = wiki_pages.workspace_id
	AND other.slug = wiki_pages.slug || '-page'
	AND other.deleted_at IS NULL
);

-- Pass 2: anything left (the `-page` slug was taken) gets an id-derived suffix.
UPDATE wiki_pages
SET slug = slug || '-page-' || substr(replace(id, '-', ''), 1, 8), version = version + 1
WHERE slug IN (
	'view', 'index', 'templates', 'tree', 'search', 'broken-links', 'stale-pages',
	'backfill-links', 'watches', 'notifications', 'trash', 'purge-trash', 'changes', 'export'
);
