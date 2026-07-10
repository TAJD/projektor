-- Collaboration-shape metrics (PROJ-328): indexed, write-once in_review_at timestamp,
-- same pattern as ready_at/claimed_at/done_at (0023) — stamped the FIRST time an issue
-- enters a review status and never cleared, so review latency still reflects rework
-- after a bounce back out of review.
--
-- "Entering review" isn't a status_category (task_statuses.category has no 'in_review'
-- value — the default review status's category is 'in_progress') — it's detected the
-- same way the review gate (PROJ-292) detects it: any status key matching /review/i, so
-- a workspace's custom review status name still counts.
ALTER TABLE issues ADD COLUMN in_review_at INTEGER;

-- Counts bounces OUT of review back to in-progress (not forward to done) — the "a human
-- sent it back for more work" signal for the human-interventions metric.
ALTER TABLE issues ADD COLUMN review_bounce_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_issues_workspace_in_review_at ON issues(workspace_id, in_review_at);

-- Comment author kind (PROJ-328): stamped from the authenticated principal type at
-- write time (Cloudflare Access JWT => human, Bearer API token => agent — see
-- middleware/auth.ts), not the deprecated agent_sessions.kind (PROJ-336), which was
-- caller-declared with no privilege check. NULL for comments written before this column
-- existed — there is no reliable signal to backfill principal type for those, so they're
-- excluded from the human-interventions metric rather than guessed.
ALTER TABLE issue_comments ADD COLUMN author_kind TEXT;
