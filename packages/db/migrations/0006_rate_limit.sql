-- Rate-limit counters table (PROJ-19).
-- Fixed-window counters keyed by "ip:{ip}" or "tok:{sha256-prefix}".
-- The middleware atomically upserts rows via ON CONFLICT; old windows are
-- overwritten in-place when a new slot arrives, so this table stays small.
CREATE TABLE IF NOT EXISTS rate_limit (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
