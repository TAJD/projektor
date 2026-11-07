import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import { OMISSION_NOTE } from "../mcp/serialize";
import { ListMessagesSchema, PostMessageSchema } from "../schemas/agent-messages";
import { listMessages, postMessage } from "../services/agent-messages";
import { defineOperation } from "./define";

const base = {
	domain: "agent-messages",
	keywords: ["chat", "coordination", "channel", "broadcast", "fleet", "notify"],
};

function slimMessage(row: Record<string, unknown>): Record<string, unknown> {
	const { workspaceId: _workspaceId, ...rest } = row;
	return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null));
}

export const agentMessageOperations = [
	defineOperation({
		...base,
		id: "post_message",
		method: "POST",
		path: "/api/agent-messages",
		tier: "write",
		annotations: PLAIN_WRITE,
		status: 201,
		summary:
			"Post a coordination message to a channel so the agent fleet can communicate: the workspace " +
			"(default when scope is omitted), an issue, or a project (readable only by members who can " +
			"see that project). Returns {id, scope, createdAt}; pass verbose:true for the whole stored row.",
		input: PostMessageSchema.safeExtend({
			verbose: z.boolean().optional().meta({
				description:
					"Return the whole stored row instead of {id, scope, createdAt} (default false)",
			}),
		}),
		run: (ctx, input) => postMessage(ctx, input),
		mcpResult: (result, { verbose }) => {
			const row = result as Awaited<ReturnType<typeof postMessage>>;
			return verbose ? row : { id: row.id, scope: row.scope, createdAt: row.createdAt };
		},
	}),
	defineOperation({
		...base,
		id: "list_messages",
		method: "GET",
		path: "/api/agent-messages",
		tier: "read",
		mcpDefaults: { order: "desc", limit: 20 },
		summary:
			"List coordination messages for a channel (workspace by default, an issue, or a project), " +
			"newest first by default. Returns {items, nextCursor}; rows omit workspaceId and null keys. " +
			OMISSION_NOTE,
		input: ListMessagesSchema.safeExtend({
			verbose: z.boolean().optional().meta({
				description:
					"Return the raw stored rows, including workspaceId and null keys (default false)",
			}),
		}),
		run: (ctx, input) => listMessages(ctx, input),
		mcpResult: (result, { verbose }) => {
			const page = result as Awaited<ReturnType<typeof listMessages>>;
			return verbose ? page : { ...page, items: page.items.map(slimMessage) };
		},
	}),
];
