-- Factory health signals (PROJ-334): fault data for the health-tile row on the metrics
-- page — is the machinery running clean?
--
-- File claims currently record no release reason at all (unlike issue_leases, which
-- already has release_reason since 0021) — releaseFiles (deliberate release, e.g. after
-- completion) and releaseClaimsForAgent (stamped when an agent session ends) both just
-- clear released_at. Add the column so "abandoned claim" (released via agent end, not
-- completion) becomes distinguishable. There's no separate expiry sweep for file claims
-- today (unlike leases, which get opportunistically reclaimed as "expired" — see
-- issue-leases.ts), so "agent_ended" is the only abandonment reason this can record.
ALTER TABLE issue_file_claims ADD COLUMN release_reason TEXT;

-- Gate rejections (in_review -> in_progress bounces specifically, narrower than the
-- aggregate issues.review_bounce_count from PROJ-328, which also counts review ->
-- cancelled). review_bounce_count is a write-once-per-issue running total with no
-- timestamp, so it can't be windowed by when a bounce happened — an event log is needed
-- to answer "how many gate rejections in this date range", the same way issue_leases/
-- issue_file_claims already answer "how many expiries/abandonments in this date range"
-- via released_at.
CREATE TABLE issue_gate_rejections (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
	occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_issue_gate_rejections_workspace_occurred ON issue_gate_rejections(workspace_id, occurred_at);
