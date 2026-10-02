import type { MCPTool } from "@projektor/types";
import { listMessages, postMessage } from "../services/agent-messages";
import { PLAIN_WRITE, READ } from "./annotations";

export const agentMessagesTools: MCPTool[] = [
	{
		name: "post_message",
		description:
			"Post a coordination message to a workspace or issue channel so the agent fleet can communicate",
		inputSchema: {
			type: "object",
			required: ["scope", "body"],
			properties: {
				scope: {
					type: "string",
					description:
						'Channel scope: "workspace" for the workspace-wide channel, or "issue:<uuid>" / "issue:<ref like PROJ-42>" for an issue channel (both spellings name the same channel)',
				},
				agentId: {
					type: "string",
					description: "Agent session UUID posting the message (optional)",
				},
				body: { type: "string", description: "Message body (1–5000 characters)" },
			},
		},
		annotations: PLAIN_WRITE,
		handler(input, ctx) {
			return postMessage(ctx, input);
		},
	},
	{
		name: "list_messages",
		description:
			"List coordination messages for a workspace or issue channel, in chronological order",
		inputSchema: {
			type: "object",
			required: ["scope"],
			properties: {
				scope: {
					type: "string",
					description: 'Channel scope: "workspace", "issue:<uuid>" or "issue:<ref like PROJ-42>"',
				},
				cursor: {
					type: "string",
					description: "Pagination cursor: pass the previous page's `nextCursor` unchanged",
				},
				limit: { type: "number", description: "Max messages to return (1–100, default 50)" },
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return listMessages(ctx, input);
		},
	},
];
