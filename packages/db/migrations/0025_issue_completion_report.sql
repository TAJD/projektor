-- Review gating (PROJ-254): stamped when a completion report is submitted with an
-- issue update. Gates the in_review->done transition for human-initiated updates.
ALTER TABLE issues ADD COLUMN completion_report_at INTEGER;
