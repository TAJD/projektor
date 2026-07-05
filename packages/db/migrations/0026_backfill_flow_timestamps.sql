-- Backfill flow-metric timestamps (PROJ-288). Migration 0023 only stamps
-- ready_at/claimed_at/done_at on FUTURE transitions, so issues that were
-- already done before that migration ran never pick up done_at (they never
-- transition again) and are silently excluded from lead/cycle metrics.

-- done_at: completed_at (0022) already records when the issue entered done,
-- so reuse it directly rather than approximating further.
UPDATE issues SET done_at = completed_at
  WHERE completed_at IS NOT NULL AND done_at IS NULL;

-- ready_at: best-effort floor, not an exact value — an issue that is past
-- backlog was ready no later than when it was created.
UPDATE issues SET ready_at = created_at
  WHERE ready_at IS NULL AND status != 'backlog';

-- claimed_at: best-effort floor — anything that reached in-progress-or-beyond
-- (including issues already done) was claimed no later than when it was created.
UPDATE issues SET claimed_at = created_at
  WHERE claimed_at IS NULL
    AND (status_category = 'in_progress' OR status IN ('in_progress', 'in_review') OR done_at IS NOT NULL);
