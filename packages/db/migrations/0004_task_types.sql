CREATE TABLE `task_types` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`icon` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX `task_types_workspace_key_idx` ON `task_types` (`workspace_id`,`key`);
CREATE INDEX `task_types_workspace_idx` ON `task_types` (`workspace_id`);
ALTER TABLE `issues` ADD `type_id` text REFERENCES `task_types`(`id`) ON DELETE SET NULL;
