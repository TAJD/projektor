CREATE TABLE crm_products (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  onboarding_template TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_products_workspace_idx ON crm_products (workspace_id);

CREATE TABLE crm_pricing_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES crm_products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interval TEXT NOT NULL CHECK(interval IN ('one_off','monthly','annual')),
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_pricing_plans_workspace_idx ON crm_pricing_plans (workspace_id);
CREATE INDEX crm_pricing_plans_product_idx ON crm_pricing_plans (product_id);

CREATE TABLE crm_fx_rates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate TEXT NOT NULL,
  as_of INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','auto')),
  created_at INTEGER NOT NULL
);
CREATE INDEX crm_fx_rates_workspace_idx ON crm_fx_rates (workspace_id);
CREATE UNIQUE INDEX crm_fx_rates_workspace_pair_idx ON crm_fx_rates (workspace_id, from_currency, to_currency);

CREATE TABLE workspace_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
