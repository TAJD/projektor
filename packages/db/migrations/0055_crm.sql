CREATE TABLE crm_organisations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_organisations_workspace_idx ON crm_organisations (workspace_id);
CREATE UNIQUE INDEX crm_organisations_workspace_domain_idx ON crm_organisations (workspace_id, domain);

CREATE TABLE crm_contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT,
  consent_basis TEXT NOT NULL CHECK(consent_basis IN ('contract','legitimate_interest','consent')),
  consent_at INTEGER NOT NULL,
  retention_until INTEGER,
  anonymised_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_contacts_workspace_idx ON crm_contacts (workspace_id);
CREATE INDEX crm_contacts_org_idx ON crm_contacts (org_id);
CREATE INDEX crm_contacts_workspace_email_idx ON crm_contacts (workspace_id, email);

CREATE TABLE crm_deals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  pipeline_id TEXT,
  stage_id TEXT,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  expected_close INTEGER,
  currency TEXT NOT NULL,
  value_override INTEGER,
  value_base INTEGER,
  fx_rate REAL,
  lost_reason TEXT,
  won_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_deals_workspace_idx ON crm_deals (workspace_id);
CREATE INDEX crm_deals_org_idx ON crm_deals (org_id);

CREATE TABLE crm_deal_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  product_id TEXT,
  plan_id TEXT,
  qty INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX crm_deal_lines_workspace_idx ON crm_deal_lines (workspace_id);
CREATE INDEX crm_deal_lines_deal_idx ON crm_deal_lines (deal_id);

CREATE TABLE crm_interactions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('call','email','demo','note')),
  occurred_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX crm_interactions_workspace_idx ON crm_interactions (workspace_id);
CREATE INDEX crm_interactions_deal_idx ON crm_interactions (deal_id);

CREATE TABLE crm_interaction_contacts (
  interaction_id TEXT NOT NULL REFERENCES crm_interactions(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (interaction_id, contact_id)
);
CREATE INDEX crm_interaction_contacts_contact_idx ON crm_interaction_contacts (contact_id);
