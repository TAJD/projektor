-- PROJ-378: direct user feedback ingestion. A `feedback_source` is a named,
-- independently-credentialed collection point an admin sets up; external product
-- code submits against its token. `id` is the source's stable identity (every
-- feedback row points at it); `token_hash` is the rotatable credential kept in a
-- separate column so rotation never loses the source's identity/history.
CREATE TABLE `feedback_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
	`name` text NOT NULL,
	`description` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`allowed_origins` text,
	`created_by` text NOT NULL REFERENCES `users`(`id`) ON DELETE NO ACTION,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
CREATE UNIQUE INDEX `idx_feedback_sources_token_hash` ON `feedback_sources` (`token_hash`);
CREATE INDEX `idx_feedback_sources_project` ON `feedback_sources` (`project_id`);

CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL REFERENCES `feedback_sources`(`id`) ON DELETE CASCADE,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
	`rating` integer,
	`rating_scale` text,
	`body` text,
	`submitter_label` text,
	`source_url` text,
	`app_version` text,
	`status` text DEFAULT 'new' NOT NULL,
	`linked_issue_id` text REFERENCES `issues`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `idx_feedback_source_status` ON `feedback` (`source_id`,`status`);
CREATE INDEX `idx_feedback_project_status` ON `feedback` (`project_id`,`status`);
