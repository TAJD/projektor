import { GetToolUsageSchema } from "../schemas/tool-usage";
import { getToolUsage } from "../services/tool-usage";
import { defineOperation } from "./define";

export const toolUsageOperations = [
	defineOperation({
		id: "get_tool_usage",
		method: "GET",
		path: "/api/tool-usage",
		domain: "tool-usage",
		tier: "read",
		keywords: ["telemetry", "tokens", "cost", "mcp", "analytics", "response size"],
		summary:
			"MCP tool-call telemetry for this workspace: per tool, the calls, error results (with " +
			"counts per error code), average server latency and total/average response bytes (a " +
			"proxy for the tokens agents spend reading results), sorted by bytes. Counted from the start of a UTC day; defaults to the last 7 days. Use " +
			"it to find the tools whose results cost agents the most. Returns available:false when " +
			"the deployment has not configured reading usage back from Analytics Engine.",
		input: GetToolUsageSchema,
		run: (ctx, input) => getToolUsage(ctx, input),
	}),
];
