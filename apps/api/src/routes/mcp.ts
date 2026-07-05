import type { HonoEnv, MCPTool, PluginContext, Role } from "@projektor/types";
import { Hono } from "hono";
import { capabilityForMcpTool, tokenAllows } from "../auth/scopes";
import { agentMessagesTools } from "../mcp/agent-messages";
import { agentsTools } from "../mcp/agents";
import { commentsTools } from "../mcp/comments";
import { customFieldsTools } from "../mcp/custom-fields";
import { toMcpError } from "../mcp/error-adapter";
import { fileClaimsTools } from "../mcp/file-claims";
import { issueLeasesTools } from "../mcp/issue-leases";
import { issueLinksTools } from "../mcp/issue-links";
import { issuesTools } from "../mcp/issues";
import { projectActivityTools } from "../mcp/project-activity";
import { projectsTools } from "../mcp/projects";
import { sprintsTools } from "../mcp/sprints";
import { taskStatusesTools } from "../mcp/task-statuses";
import { taskTypesTools } from "../mcp/task-types";
import { wikiTools } from "../mcp/wiki";
import { workspacesTools } from "../mcp/workspaces";
import { pluginRegistry } from "../plugins/registry";

// __PROJEKTOR_VERSION__ is injected by esbuild --define at release-build time
// (scripts/build-release.sh); it's absent in local `wrangler dev` and tests.
const SERVER_VERSION = typeof __PROJEKTOR_VERSION__ === "string" ? __PROJEKTOR_VERSION__ : "dev";

// Surfaced to every MCP client at `initialize` (the MCP spec's optional
// `instructions` field). Clients like Claude Code inject this into the model's
// context, so any session with the Projektor MCP connected learns the fleet
// coordination protocol without it being repeated in each spawn prompt. Framed
// conditionally so it's a no-op for solo sessions. Keep in sync with the
// "Fleet coordination protocol" in AGENTS.md.
const SERVER_INSTRUCTIONS = `Projektor is an MCP-native issue tracker + wiki. Every project-management action a \
browser user can take is available here as a tool.

Handy entry points: get_issue accepts a ref like "PROJ-42" (no UUID needed); get_prioritized_issues answers \
"what should I work on next?"; search_issues / search_wiki ground you in existing context before you act.

Fleet coordination — only when you are one of several agents working in parallel on a shared repo. Use these \
primitives so parallel agents don't collide:
1. register_agent at session start — link the issue you're implementing; save the returned id.
2. claim_files before editing any file — check list_file_claims first and back off if another issue already \
holds it (don't force).
3. post_message to scope "issue:<uuid>" when you start, hit a blocker, and finish; use scope "workspace" for \
fleet-wide notices (e.g. "rebasing mcp.ts, hold off").
4. heartbeat_agent every ~60s while working (sessions time out after 120s of silence).
5. release_files then end_agent when done.

A single agent acting alone can ignore the coordination steps and just use the project-management tools directly.`;

const router = new Hono<HonoEnv>();

// MCP endpoint: POST /mcp/{workspaceId}
// Implements JSON-RPC 2.0 over HTTP (MCP Streamable HTTP transport)
router.post("/:workspaceId", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };
	const role = c.get("role") as Role | undefined;
	const body = await c.req.json<{
		jsonrpc: "2.0";
		id: unknown;
		method: string;
		params?: unknown;
	}>();

	if (body.jsonrpc !== "2.0") {
		return c.json(jsonRpcError(body.id, -32600, "Invalid Request"), 400);
	}

	const ctx: PluginContext = {
		db: c.env.DB,
		kv: c.env.KV,
		r2: c.env.R2,
		workspaceId: workspace.id,
		userId: user.id,
		role,
	};

	switch (body.method) {
		case "initialize":
			return c.json(
				jsonRpcResult(body.id, {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "projektor", version: SERVER_VERSION },
					instructions: SERVER_INSTRUCTIONS,
				})
			);

		case "tools/list": {
			const tools = getAllTools(workspace.id);
			return c.json(
				jsonRpcResult(body.id, {
					tools: tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
					})),
				})
			);
		}

		case "tools/call": {
			const { name, arguments: args } = body.params as { name: string; arguments: unknown };
			const tool = getAllTools(workspace.id).find((t) => t.name === name);
			if (!tool) return c.json(jsonRpcError(body.id, -32601, `Tool not found: ${name}`));

			// PROJ-17: enforce token scope per-tool. tokenScopes is undefined when
			// auth came from Cloudflare Access / dev bypass — those are role-governed,
			// not scope-restricted, so the check is skipped for them.
			const scopes = c.get("tokenScopes");
			if (scopes) {
				const required = capabilityForMcpTool(name);
				if (!tokenAllows(scopes, required)) {
					return c.json(jsonRpcError(body.id, -32003, `Token lacks '${required}' scope`));
				}
			}

			try {
				const result = await tool.handler(args, ctx);
				return c.json(
					jsonRpcResult(body.id, {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					})
				);
			} catch (err) {
				const { code, message } = toMcpError(err);
				return c.json(jsonRpcError(body.id, code, message));
			}
		}

		default:
			return c.json(jsonRpcError(body.id, -32601, "Method not found"));
	}
});

function getAllTools(workspaceId: string): MCPTool[] {
	return [...coreMCPTools, ...pluginRegistry.getToolsForWorkspace(workspaceId)];
}

const coreMCPTools: MCPTool[] = [
	...workspacesTools,
	...projectsTools,
	...projectActivityTools,
	...issuesTools,
	...issueLinksTools,
	...commentsTools,
	...wikiTools,
	...taskTypesTools,
	...taskStatusesTools,
	...customFieldsTools,
	...sprintsTools,
	...agentsTools,
	...fileClaimsTools,
	...issueLeasesTools,
	...agentMessagesTools,
];

function jsonRpcResult(id: unknown, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

export { router as mcpRouter };
