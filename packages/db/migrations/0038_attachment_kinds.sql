ALTER TABLE `attachments` ADD `kind` text DEFAULT 'file' NOT NULL;
--> statement-breakpoint
ALTER TABLE `attachments` ADD `url` text;
--> statement-breakpoint
ALTER TABLE `attachments` ADD `linked_wiki_page_id` text REFERENCES wiki_pages(id);
