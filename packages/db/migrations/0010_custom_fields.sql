CREATE TABLE `custom_field_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE CASCADE,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL CHECK(`type` IN ('text','number','select','date','user')),
	`options` text,
	`created_at` integer NOT NULL
);
CREATE INDEX `cfd_workspace_idx` ON `custom_field_definitions` (`workspace_id`);
CREATE UNIQUE INDEX `cfd_ws_proj_key_idx` ON `custom_field_definitions` (`workspace_id`, COALESCE(`project_id`, ''), `key`);

CREATE TABLE `custom_field_values` (
	`issue_id` text NOT NULL REFERENCES `issues`(`id`) ON DELETE CASCADE,
	`field_id` text NOT NULL REFERENCES `custom_field_definitions`(`id`) ON DELETE CASCADE,
	`value` text NOT NULL,
	PRIMARY KEY (`issue_id`, `field_id`)
);
CREATE INDEX `cfv_field_idx` ON `custom_field_values` (`field_id`);

-- Seed built-in story_points number field for all existing workspaces (idempotent via INSERT OR IGNORE)
INSERT OR IGNORE INTO `custom_field_definitions` (`id`, `workspace_id`, `project_id`, `key`, `label`, `type`, `options`, `created_at`)
SELECT lower(hex(randomblob(16))), `id`, NULL, 'story_points', 'Story Points', 'number', NULL, strftime('%s', 'now') FROM `workspaces`;
