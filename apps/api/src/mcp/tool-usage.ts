import type { MCPTool } from "@projektor/types";
import { getToolUsage } from "../services/tool-usage";
import { READ } from "./annotations";

export const toolUsageTools: MCPTool[] = [
	{
		name: "get_tool_usage",
		description:
			"MCP tool-call telemetry for this workspace: per tool, the calls, error results and " +
			"total/average response bytes (a proxy for the tokens agents spend reading results), " +
			"sorted by bytes. Counted per UTC day; defaults to the last 7 days. Use it to find the " +
			"tools whose results cost agents the most.",
		inputSchema: {
			type: "object",
			properties: {
				since: {
					type: "integer",
					minimum: 0,
					description: "Epoch seconds; counts from the start of that UTC day (default 7 days ago)",
				},
				until: { type: "integer", minimum: 0, description: "Epoch seconds (default now)" },
				tool: { type: "string", description: "Only this tool" },
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 200,
					default: 25,
					description: "Max tools listed (the total still covers every tool)",
				},
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return getToolUsage(ctx, input);
		},
	},
];
