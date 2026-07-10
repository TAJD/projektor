import type { MCPTool } from "@projektor/types";
import { endAgent, heartbeatAgent, listActiveAgents, registerAgent } from "../services/agents";
import { ValidationError } from "../services/errors";

export const agentsTools: MCPTool[] = [
	{
		name: "register_agent",
		description: "Register an agent session, optionally linked to an issue",
		inputSchema: {
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string", description: "Display name for the agent session (max 200)" },
				issueId: { type: "string", description: "Issue UUID to link this session to (optional)" },
				kind: {
					type: "string",
					enum: ["agent", "human"],
					description:
						"Deprecated, ignored (PROJ-336): self-declared session kind drives no behavior and is not returned.",
				},
			},
		},
		handler(input, ctx) {
			return registerAgent(ctx, input);
		},
	},
	{
		name: "heartbeat_agent",
		description: "Send a heartbeat to keep an agent session active",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "Agent session UUID" },
			},
		},
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return heartbeatAgent(ctx, { id });
		},
	},
	{
		name: "end_agent",
		description: "End an agent session",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "Agent session UUID" },
			},
		},
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return endAgent(ctx, { id });
		},
	},
	{
		name: "list_active_agents",
		description: "List active agent sessions in the workspace, optionally filtered by issue",
		inputSchema: {
			type: "object",
			properties: {
				issueId: { type: "string", description: "Filter by issue UUID (optional)" },
			},
		},
		handler(input, ctx) {
			return listActiveAgents(ctx, input);
		},
	},
];
