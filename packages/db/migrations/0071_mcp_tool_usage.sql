-- PROJ-1055: per-workspace, per-day, per-tool MCP call telemetry. One row per
-- (workspace, UTC day, tool), upserted off the response path by routes/mcp.ts, so
-- agents' token cost can be measured by tool instead of estimated. No FK: rows are
-- removed explicitly by deleteWorkspace (AGENTS.md: deletes never rely on cascades).
CREATE TABLE mcp_tool_usage (
	workspace_id TEXT NOT NULL,
	day INTEGER NOT NULL,
	tool TEXT NOT NULL,
	calls INTEGER NOT NULL DEFAULT 0,
	errors INTEGER NOT NULL DEFAULT 0,
	response_bytes INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (workspace_id, day, tool)
);
