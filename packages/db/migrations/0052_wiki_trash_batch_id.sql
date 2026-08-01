-- 0051: R14 follow-up (PROJ-496) — track cascade-trash batch identity explicitly.
--
-- `deleted_at` equality was used as a stand-in for "was this page part of the same
-- cascade-trash call" (services/wiki.ts#collectCascadeTrashedDescendantIds), but two
-- independent single-page trashes landing in the same wall-clock second collide on that
-- key and get incorrectly treated as one batch. `trash_batch_id` is stamped once per
-- deleteWikiPage call (cascade or not) with a fresh UUID, so batch membership no longer
-- depends on timestamp precision.
ALTER TABLE wiki_pages ADD COLUMN trash_batch_id text;

CREATE INDEX `wiki_pages_trash_batch_id_idx` ON `wiki_pages` (`workspace_id`, `trash_batch_id`);
