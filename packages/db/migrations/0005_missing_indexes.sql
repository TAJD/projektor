CREATE INDEX `issue_comments_issue_idx` ON `issue_comments` (`issue_id`);
CREATE INDEX `issues_assignee_idx` ON `issues` (`assignee_id`);
CREATE INDEX `issues_workspace_status_idx` ON `issues` (`workspace_id`,`status`);
