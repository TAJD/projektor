-- PROJ-241: custom field definitions have no privacy flag, so getSharedIssue (public,
-- unauthenticated) leaks every custom field on a shared issue. Add an opt-in visibility
-- flag defaulting to internal (1) so existing and newly created fields stay hidden from
-- public share payloads unless explicitly marked otherwise.
ALTER TABLE `custom_field_definitions` ADD COLUMN `is_internal` integer NOT NULL DEFAULT 1;
