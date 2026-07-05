-- Per-project agent WIP cap (PROJ-253). NULL = use the workspace-wide default
-- (services/issue-leases.ts::DEFAULT_AGENT_WIP_LIMIT).
ALTER TABLE projects ADD COLUMN agent_wip_limit INTEGER;
