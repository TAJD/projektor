-- PROJ-869: activity.diff previously stored the full new page content on every wiki
-- page save (services/wiki.ts's buildWikiPageUpdateDiff) and the full new body on every
-- issue update (services/issues.ts's buildUpdateDiffCore) — on top of the copy already
-- held in wiki_pages/wiki_revisions/issues/the FTS index, and read back in full by
-- list_wiki_changes for every row even though only "deleted" events use `diff` at all.
-- Going forward the write paths record only a small "contentChanged"/"bodyChanged"
-- marker (see wiki.ts/issues.ts) — this strips the large values already persisted.
-- json_valid(diff) guards both statements: one malformed diff value (never expected, but
-- json_extract/json_remove raise on invalid JSON) would otherwise abort the whole
-- migration instead of just being skipped.
UPDATE activity
SET diff = json_remove(diff, '$.content')
WHERE entity_type = 'wiki_page'
	AND diff IS NOT NULL
	AND json_valid(diff)
	AND json_extract(diff, '$.content') IS NOT NULL;

UPDATE activity
SET diff = json_remove(diff, '$.body')
WHERE entity_type = 'issue'
	AND diff IS NOT NULL
	AND json_valid(diff)
	AND json_extract(diff, '$.body') IS NOT NULL;
