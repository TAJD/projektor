-- Backfill in_review_at (PROJ-328), same rationale as 0026: in_review_at is only stamped
-- on the transition INTO review (0029/issues.ts applyReviewTransitions). An issue that was
-- already sitting in a review status before 0029 landed never re-enters review, so it would
-- never pick up in_review_at and would be silently excluded from review-latency once it's
-- eventually marked done.
--
-- Deliberately narrower than 0026's claimed_at/ready_at backfill: those floors apply to
-- every done issue (every done issue was necessarily claimed at some point). Review is
-- NOT on every issue's path (an issue can be closed directly from in-progress), and there
-- is no historical record of which done issues passed through review before this column
-- existed — guessing would inflate review-latency for issues that were never reviewed at
-- all. So this only backfills issues CURRENTLY sitting in a review status (still
-- reachable, not yet a guess): claimed_at is the best available floor for when they
-- entered review.
UPDATE issues SET in_review_at = claimed_at
  WHERE in_review_at IS NULL
    AND claimed_at IS NOT NULL
    AND lower(status) LIKE '%review%';

-- review_bounce_count has no equivalent floor — there is no historical record of status
-- bounces prior to this migration, so pre-existing issues are left at their DEFAULT 0
-- rather than guessed.
