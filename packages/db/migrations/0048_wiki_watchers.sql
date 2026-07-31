-- 0048: R11 (PROJ-493) — wiki watchers + per-user notification list + list_wiki_changes.
--
-- wiki_watchers: a user watching either a single page (subtree=0) or a page and its
-- whole current+future subtree (subtree=1). Resolving "is user U watching page P" walks
-- P's parent_id chain at read/write time rather than materializing descendant rows, so a
-- page added under a watched subtree later is automatically covered with no backfill
-- (services/wiki-watchers.ts#notifyWikiWatchers). page_id cascades on delete — watching a
-- page that's later hard-deleted just drops the watch, nothing to preserve there. The FK
-- is belt-and-braces only: deleteWikiPage also removes the rows explicitly
-- (wiki-watchers.ts#deleteWikiWatchersForPages), since D1 doesn't guarantee FK enforcement
-- on every connection — the same PROJ-407 precedent as wiki attachments/links.
CREATE TABLE `wiki_watchers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`page_id` text NOT NULL REFERENCES `wiki_pages`(`id`) ON DELETE CASCADE,
	`subtree` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL
);

-- One watch row per (user, page) — watch_wiki_page upserts (e.g. flipping subtree on/off)
-- rather than accumulating duplicates.
CREATE UNIQUE INDEX `wiki_watchers_user_page_idx` ON `wiki_watchers` (`workspace_id`, `user_id`, `page_id`);
-- notifyWikiWatchers looks up watchers of a page (and its ancestors, for subtree
-- watches) by page_id within a workspace.
CREATE INDEX `wiki_watchers_page_idx` ON `wiki_watchers` (`workspace_id`, `page_id`);

-- wiki_notifications: per-user notification list, one row per (watcher, change). Denormalizes
-- page_slug/page_title at write time (NOT a page_id foreign key) so a notification about a
-- page that's since been deleted still displays something meaningful — see
-- services/wiki-watchers.ts's notifyWikiWatchers for why this can't just join wiki_pages.
CREATE TABLE `wiki_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`page_id` text NOT NULL,
	`page_slug` text NOT NULL,
	`page_title` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer
);

-- list_wiki_notifications reads a user's own notifications within a workspace, newest first.
CREATE INDEX `wiki_notifications_user_idx` ON `wiki_notifications` (`workspace_id`, `user_id`, `created_at`);

-- list_wiki_changes (delta polling) piggybacks on the existing `activity` table — every
-- wiki_page create/update/delete already calls recordActivity (services/activity.ts), so
-- no separate change log is needed. This index makes "entity_type='wiki_page' AND
-- created_at >= since" within a workspace an indexed range scan instead of a full scan of
-- the workspace's activity rows filtered in SQLite.
CREATE INDEX `activity_workspace_entity_created_idx` ON `activity` (`workspace_id`, `entity_type`, `created_at`);
