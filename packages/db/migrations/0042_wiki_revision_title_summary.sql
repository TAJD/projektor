-- PROJ-484: revisions gain a title snapshot (the page title at that revision) and an
-- optional summary (a short edit-message/changelog note the writer can supply), so
-- optimistic-locking conflicts can show the caller more than just a raw content diff.
ALTER TABLE wiki_revisions ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE wiki_revisions ADD COLUMN summary TEXT;
