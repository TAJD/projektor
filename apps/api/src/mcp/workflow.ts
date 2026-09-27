import type { MCPTool } from "@projektor/types";
import { getWorkflow } from "../services/workflow";
import { READ } from "./annotations";

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
		annotations: READ,
		async handler() {
			return getWorkflow();
		},
	},
];
