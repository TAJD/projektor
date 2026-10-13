import type { MCPTool } from "@projektor/types";
import { listMessages, postMessage } from "../services/agent-messages";
import { PLAIN_WRITE, READ } from "./annotations";
import { OMISSION_NOTE } from "./serialize";

function slimMessage(row: Record<string, unknown>): Record<string, unknown> {
	const { workspaceId: _workspaceId, ...rest } = row;
	return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null));
}

export const agentMessagesTools: MCPTool[] = [
	{
		name: "post_message",
		description:
			"Post a coordination message to a channel so the agent fleet can communicate: the workspace " +
			"(default when scope is omitted), an issue, or a project (readable only by members who can " +
			"see that project). Returns {id, scope, createdAt}; pass verbose:true for the whole stored row.",
		inputSchema: {
			type: "object",
			required: ["body"],
			properties: {
				scope: {
					type: "string",
					description:
						'Channel scope: "workspace" (default), "issue:<uuid>" / "issue:<ref like PROJ-42>" (or just the bare uuid/ref), "project:<key|uuid>", or "project" together with projectId. Every spelling of a channel names the same channel',
				},
				projectId: {
					type: "string",
					description:
						'Project key (e.g. PROJ) or UUID. Use with scope "project"; on its own it selects that project\'s channel',
				},
				agentId: {
					type: "string",
					description: "Agent session UUID posting the message (optional)",
				},
				body: {
					type: "string",
					minLength: 1,
					maxLength: 5000,
					description: "Message body (1–5000 characters)",
				},
				verbose: {
					type: "boolean",
					description:
						"Return the whole stored row instead of {id, scope, createdAt} (default false)",
				},
			},
		},
		annotations: PLAIN_WRITE,
		async handler(input, ctx) {
			const row = await postMessage(ctx, input);
			if ((input as { verbose?: unknown } | undefined)?.verbose === true) return row;
			return { id: row.id, scope: row.scope, createdAt: row.createdAt };
		},
	},
	{
		name: "list_messages",
		description:
			"List coordination messages for a channel (workspace by default, an issue, or a project), " +
			"newest first by default. Returns {items, nextCursor}; rows omit workspaceId and null keys. " +
			OMISSION_NOTE,
		inputSchema: {
			type: "object",
			properties: {
				scope: {
					type: "string",
					description:
						'Channel scope: "workspace" (default), "issue:<uuid>" / "issue:<ref like PROJ-42>" (or just the bare uuid/ref), "project:<key|uuid>", or "project" together with projectId',
				},
				projectId: {
					type: "string",
					description:
						'Project key (e.g. PROJ) or UUID. Use with scope "project"; on its own it selects that project\'s channel',
				},
				order: {
					type: "string",
					enum: ["asc", "desc"],
					description: "desc = newest first (default), asc = oldest first",
				},
				since: {
					type: "number",
					description:
						"Unix seconds: only messages created at or after this time (rows' createdAt is in milliseconds)",
				},
				cursor: {
					type: "string",
					description: "Pagination cursor: pass the previous page's `nextCursor` unchanged",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 100,
					description: "Max messages to return (1–100, default 20)",
				},
				verbose: {
					type: "boolean",
					description:
						"Return the raw stored rows, including workspaceId and null keys (default false)",
				},
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { verbose, order, limit, ...rest } = (input ?? {}) as Record<string, unknown>;
			const page = await listMessages(ctx, {
				...rest,
				order: order ?? "desc",
				limit: limit ?? 20,
			});
			if (verbose === true) return page;
			return { ...page, items: page.items.map(slimMessage) };
		},
	},
];
