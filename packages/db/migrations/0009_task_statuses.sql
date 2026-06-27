CREATE TABLE `task_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL CHECK(`category` IN ('todo','in_progress','done','cancelled')),
	`color` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL
);
CREATE INDEX `task_statuses_workspace_idx` ON `task_statuses` (`workspace_id`);
CREATE UNIQUE INDEX `task_statuses_workspace_key_idx` ON `task_statuses` (`workspace_id`,`key`);

-- Seed defaults for all existing workspaces
INSERT INTO `task_statuses` (`id`, `workspace_id`, `key`, `name`, `category`, `color`, `position`, `is_default`)
SELECT lower(hex(randomblob(16))), `id`, 'backlog', 'Backlog', 'todo', NULL, 1, 1 FROM `workspaces`;
INSERT INTO `task_statuses` (`id`, `workspace_id`, `key`, `name`, `category`, `color`, `position`, `is_default`)
SELECT lower(hex(randomblob(16))), `id`, 'todo', 'Todo', 'todo', NULL, 2, 0 FROM `workspaces`;
INSERT INTO `task_statuses` (`id`, `workspace_id`, `key`, `name`, `category`, `color`, `position`, `is_default`)
SELECT lower(hex(randomblob(16))), `id`, 'in_progress', 'In Progress', 'in_progress', NULL, 3, 0 FROM `workspaces`;
INSERT INTO `task_statuses` (`id`, `workspace_id`, `key`, `name`, `category`, `color`, `position`, `is_default`)
SELECT lower(hex(randomblob(16))), `id`, 'in_review', 'In Review', 'in_progress', NULL, 4, 0 FROM `workspaces`;
INSERT INTO `task_statuses` (`id`, `workspace_id`, `key`, `name`, `category`, `color`, `position`, `is_default`)
SELECT lower(hex(randomblob(16))), `id`, 'done', 'Done', 'done', NULL, 5, 0 FROM `workspaces`;
INSERT INTO `task_statuses` (`id`, `workspace_id`, `key`, `name`, `category`, `color`, `position`, `is_default`)
SELECT lower(hex(randomblob(16))), `id`, 'cancelled', 'Cancelled', 'cancelled', NULL, 6, 0 FROM `workspaces`;

ALTER TABLE `issues` ADD `status_id` text REFERENCES `task_statuses`(`id`) ON DELETE SET NULL;

-- Backfill: set status_id from the legacy status string
UPDATE `issues` SET `status_id` = (
  SELECT `ts`.`id` FROM `task_statuses` `ts`
  WHERE `ts`.`workspace_id` = `issues`.`workspace_id` AND `ts`.`key` = `issues`.`status`
  LIMIT 1
);
