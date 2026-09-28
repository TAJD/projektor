import type { MCPTool } from "@projektor/types";
import { getWorkflow } from "../services/workflow";
import { READ } from "./annotations";

export const workflowTools: MCPTool[] = [
	{
		name: "get_workflow",
		description:
			"Fetch the canonical agent workflow spec: definition of ready, state machine, human gates, " +
			"completion report requirements, and WIP limits. Call this before claiming work. Returns a " +
			"content `version` (a stable hash — unchanged unless the spec content changes). Pass a " +
			"previously-returned version back as `ifVersion` to skip re-reading an unchanged spec: a " +
			"match returns just `{ unchanged: true, version }` instead of the full content.",
		inputSchema: {
			type: "object",
			properties: {
				ifVersion: {
					type: "string",
					maxLength: 64,
					description:
						"A version previously returned by get_workflow. If it matches the current version, " +
						"the response is `{ unchanged: true, version }` instead of the full spec.",
				},
			},
		},
		annotations: READ,
		async handler(input) {
			return getWorkflow(input);
		},
	},
];
