-- 0049: R13 (PROJ-495) — server-side per-user wiki drafts, replacing the PROJ-227
-- localStorage autosave so an in-progress edit survives a device switch, not just a
-- crash on the same browser.
--
-- One draft row per (page, user) — saveWikiDraft upserts rather than accumulating
-- history; a draft is scratch space, not a revision. base_revision_id is the page's
-- latest revision id as of when the draft was started (same nullable convention as
-- wiki_revisions/UpdatePageSchema.baseRevisionId: NULL means "the page had no
-- revisions yet"), so publish can resubmit through update_wiki_page's EXISTING
-- optimistic-locking check (services/wiki.ts) instead of a second conflict mechanism.
-- page_id/user_id cascade on delete — app-level cleanup also runs explicitly from
-- deleteWikiPage (services/wiki-drafts.ts#deleteWikiDraftsForPages), the same
-- belt-and-braces precedent as wiki attachments/links/watchers (PROJ-407).
CREATE TABLE `wiki_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`page_id` text NOT NULL REFERENCES `wiki_pages`(`id`) ON DELETE CASCADE,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`base_revision_id` text,
	`updated_at` integer NOT NULL
);

-- getWikiDraft/saveWikiDraft/discardWikiDraft all key off (workspace, user, page); the
-- unique index doubles as saveWikiDraft's upsert target.
CREATE UNIQUE INDEX `wiki_drafts_user_page_idx` ON `wiki_drafts` (`workspace_id`, `user_id`, `page_id`);
