-- PROJ-517/512: SlugSchema now forbids "/" in wiki_pages.slug, but that only gates
-- future writes — existing rows created before this rule (e.g. via the legacy
-- ?slug= query form) can still hold a slashy slug, which is exactly the routing bug
-- PROJ-517 describes (every matcher assumes a single path segment). Rewrite every
-- slashy slug in place ('/' -> '-') and leave a wiki_redirects row so old
-- links/bookmarks keep resolving, mirroring migration 0041's collision strategy:
-- keep the plain rewritten slug when nothing else in the workspace already holds
-- it, otherwise suffix with the row's own id (never collides with an unrelated
-- pre-existing slug, unlike a fixed/counted suffix). The candidate is truncated to
-- 191 chars before suffixing so the id-suffixed result never exceeds SlugSchema's
-- 200-char max.
-- Old slug may already carry a redirect row from an earlier, unrelated rename
-- (e.g. some other page was renamed away from this exact slug in the past) —
-- this backfill takes ownership of it, mirroring the onConflictDoUpdate upsert
-- in services/wiki.ts's rename path, rather than aborting the whole migration.
-- D1 rejects an UPSERT clause on an INSERT...SELECT whose source isn't a plain
-- table reference (no CTE, no derived subquery — "near DO: syntax error"), so
-- the upsert is expressed as delete-then-insert instead of ON CONFLICT.
DELETE FROM wiki_redirects
WHERE EXISTS (
	SELECT 1 FROM wiki_pages wp
	WHERE wp.slug LIKE '%/%'
	  AND wp.workspace_id = wiki_redirects.workspace_id
	  AND wp.slug = wiki_redirects.old_slug
);

WITH ranked AS (
	SELECT
		id,
		workspace_id,
		slug AS old_slug,
		replace(slug, '/', '-') AS candidate,
		ROW_NUMBER() OVER (
			PARTITION BY workspace_id, replace(slug, '/', '-')
			ORDER BY created_at, id
		) AS rn
	FROM wiki_pages
	WHERE slug LIKE '%/%'
),
resolved AS (
	SELECT
		r.id,
		r.workspace_id,
		r.old_slug,
		CASE
			WHEN r.rn > 1
				OR EXISTS (
					SELECT 1 FROM wiki_pages wp
					WHERE wp.workspace_id = r.workspace_id
					  AND wp.slug = r.candidate
					  AND wp.id != r.id
				)
			THEN substr(r.candidate, 1, 191) || '-' || substr(r.id, 1, 8)
			ELSE r.candidate
		END AS new_slug
	FROM ranked r
)
INSERT INTO wiki_redirects (id, workspace_id, old_slug, page_id, created_at)
SELECT
	lower(hex(randomblob(16))),
	resolved.workspace_id,
	resolved.old_slug,
	resolved.id,
	strftime('%s', 'now')
FROM resolved;

WITH ranked AS (
	SELECT
		id,
		workspace_id,
		slug AS old_slug,
		replace(slug, '/', '-') AS candidate,
		ROW_NUMBER() OVER (
			PARTITION BY workspace_id, replace(slug, '/', '-')
			ORDER BY created_at, id
		) AS rn
	FROM wiki_pages
	WHERE slug LIKE '%/%'
),
resolved AS (
	SELECT
		r.id,
		CASE
			WHEN r.rn > 1
				OR EXISTS (
					SELECT 1 FROM wiki_pages wp
					WHERE wp.workspace_id = r.workspace_id
					  AND wp.slug = r.candidate
					  AND wp.id != r.id
				)
			THEN substr(r.candidate, 1, 191) || '-' || substr(r.id, 1, 8)
			ELSE r.candidate
		END AS new_slug
	FROM ranked r
)
UPDATE wiki_pages
SET slug = (SELECT new_slug FROM resolved WHERE resolved.id = wiki_pages.id)
WHERE id IN (SELECT id FROM resolved);
