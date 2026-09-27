-- PROJ-749: a status is a review step because the workspace says so, not because its
-- key happens to contain "review". Until now the review gate and review flow metrics
-- matched /review/i on the key, so "contract_review" or "legal_review" were silently
-- treated as code review. Backfill keeps today's behaviour for every existing status
-- (admins can clear the flag on the ones that aren't review steps); statuses created
-- from now on are review steps only when created with isReviewStep: true.
ALTER TABLE task_statuses ADD COLUMN is_review_step INTEGER NOT NULL DEFAULT 0;
UPDATE task_statuses SET is_review_step = 1 WHERE lower(key) LIKE '%review%';
