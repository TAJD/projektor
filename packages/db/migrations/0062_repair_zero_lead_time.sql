-- PROJ-921: an issue moved straight from backlog to done in one update got
-- ready_at = done_at from that update, and 0026's backfill did the same for issues
-- created already done (ready_at = created_at = completed_at). Neither ever sat in a
-- ready status, so their 0s lead time dragged the median to zero. Clear ready_at on
-- those rows so lead time excludes them, as it now does for new ones.
UPDATE issues SET ready_at = NULL
WHERE ready_at IS NOT NULL AND done_at IS NOT NULL AND ready_at = done_at;
