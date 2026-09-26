-- PROJ-919: a per-page write counter. The PROJ-810 write guard compared only page
-- content, so two concurrent writes that changed just the title, slug or parent both
-- passed it and the second silently overwrote the first. Every write to a wiki_pages
-- row now bumps `version`, and the guard checks it alongside content, so any
-- concurrent write to the page (metadata included) turns the loser into a 409.
--
-- Existing rows start at 0; the counter only needs to be monotonic per row.
ALTER TABLE wiki_pages ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
