CREATE TABLE crm_pipelines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  default_onboarding_template TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_pipelines_workspace_idx ON crm_pipelines (workspace_id);

CREATE TABLE crm_stages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('open','won','lost')),
  probability INTEGER,
  required_fields TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_stages_workspace_idx ON crm_stages (workspace_id);
CREATE INDEX crm_stages_pipeline_idx ON crm_stages (pipeline_id);
