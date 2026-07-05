import type { MCPTool } from "@projektor/types";
import { getWorkflow } from "../services/workflow";

export const workflowTools: MCPTool[] = [
	{
		name: "get_workflow",
		description:
			"Fetch the canonical agent workflow spec: definition of ready, state machine, human gates, " +
			"completion report requirements, and WIP limits. Call this before claiming work.",
		inputSchema: {
			type: "object",
			properties: {},
		},
		async handler() {
			return getWorkflow();
		},
	},
];
