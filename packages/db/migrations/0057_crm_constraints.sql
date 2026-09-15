CREATE UNIQUE INDEX crm_pipelines_workspace_default_idx ON crm_pipelines (workspace_id) WHERE is_default = 1;
CREATE UNIQUE INDEX crm_stages_pipeline_position_idx ON crm_stages (pipeline_id, position);
CREATE INDEX crm_deals_workspace_stage_idx ON crm_deals (workspace_id, stage_id);
CREATE INDEX crm_deals_workspace_pipeline_idx ON crm_deals (workspace_id, pipeline_id);
