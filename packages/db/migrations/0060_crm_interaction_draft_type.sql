CREATE TABLE crm_interactions_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('call','email','demo','note','draft')),
  occurred_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO crm_interactions_new SELECT * FROM crm_interactions;
DROP TABLE crm_interactions;
ALTER TABLE crm_interactions_new RENAME TO crm_interactions;

CREATE INDEX crm_interactions_workspace_idx ON crm_interactions (workspace_id);
CREATE INDEX crm_interactions_deal_idx ON crm_interactions (deal_id);
