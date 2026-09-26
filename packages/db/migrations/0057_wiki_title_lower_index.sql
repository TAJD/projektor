-- PROJ-858: title-kind wiki links resolve with `lower(title) IN (…)` among live pages,
-- which scanned every page in the workspace. Expression + partial index so the lookup
-- is an index search.
CREATE INDEX IF NOT EXISTS idx_wiki_pages_ws_lower_title
	ON wiki_pages(workspace_id, lower(title)) WHERE deleted_at IS NULL;

PRAGMA optimize;
