CREATE TABLE crm_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK(metric IN ('deals_created','deals_won','won_value','stage_entered','onboardings_completed')),
  stage_id TEXT REFERENCES crm_stages(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK(period IN ('week','month','quarter','year')),
  period_start INTEGER NOT NULL,
  value INTEGER NOT NULL,
  currency TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_targets_workspace_idx ON crm_targets (workspace_id);
CREATE INDEX crm_targets_workspace_period_idx ON crm_targets (workspace_id, period_start);
