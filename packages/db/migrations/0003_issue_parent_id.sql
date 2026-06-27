ALTER TABLE `issues` ADD `parent_id` text;
CREATE INDEX `issues_parent_idx` ON `issues` (`parent_id`);
