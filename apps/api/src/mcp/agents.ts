import type { MCPTool } from "@projektor/types";
import {
	endAgent,
	finishWork,
	heartbeatAgent,
	listActiveAgents,
	registerAgent,
	startWork,
} from "../services/agents";
import { ValidationError } from "../services/errors";
import { PLAIN_WRITE, READ } from "./annotations";

export const agentsTools: MCPTool[] = [
	{
		name: "start_work",
		description:
			"Register an agent session and claim an issue (plus files, if given) in one call — " +
			"replaces register_agent + claim_issue + claim_files + post_message. All-or-nothing with " +
			"compensating cleanup: on any conflict (same errors as claim_issue/claim_files) the session is " +
			"ended and nothing is left claimed. If the process crashes mid-call, the same claims become " +
			"reclaimable once the session's heartbeat goes stale (120s).",
		inputSchema: {
			type: "object",
			required: ["issue", "name"],
			properties: {
				issue: { type: "string", description: "Issue UUID to claim" },
				paths: {
					type: "array",
					items: { type: "string" },
					description: "File paths to claim alongside the issue (optional)",
				},
				name: { type: "string", description: "Display name for the agent session (max 200)" },
			},
		},
		annotations: PLAIN_WRITE,
		handler(input, ctx) {
			return startWork(ctx, input);
		},
	},
	{
		name: "finish_work",
		description:
			"Optionally transition an issue (completion-report rules apply, same as update_issue), then " +
			"release every claim/lease the session holds and end it — replaces update_issue + " +
			"release_issue + release_files + end_agent.",
		inputSchema: {
			type: "object",
			required: ["sessionId", "issue"],
			properties: {
				sessionId: { type: "string", description: "Agent session UUID to end" },
				issue: { type: "string", description: "Issue UUID to optionally transition" },
				status: { type: "string", description: "New status for the issue (optional)" },
				completionReport: {
					type: "object",
					description:
						"Completion report, required by the review gate in the same cases update_issue requires it (optional)",
					properties: {
						summary: { type: "string" },
						verification: { type: "string" },
						prLink: { type: "string" },
					},
				},
			},
		},
		annotations: PLAIN_WRITE,
		handler(input, ctx) {
			return finishWork(ctx, input);
		},
	},
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
		annotations: PLAIN_WRITE,
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
		annotations: PLAIN_WRITE,
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
		annotations: PLAIN_WRITE,
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
		annotations: READ,
		handler(input, ctx) {
			return listActiveAgents(ctx, input);
		},
	},
];
