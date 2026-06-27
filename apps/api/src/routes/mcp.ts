import type { HonoEnv, MCPTool, PluginContext, Role } from "@projektor/types";
import { Hono } from "hono";
import { capabilityForMcpTool, tokenAllows } from "../auth/scopes";
import { agentMessagesTools } from "../mcp/agent-messages";
import { agentsTools } from "../mcp/agents";
import { commentsTools } from "../mcp/comments";
import { customFieldsTools } from "../mcp/custom-fields";
import { toMcpError } from "../mcp/error-adapter";
import { fileClaimsTools } from "../mcp/file-claims";
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
					serverInfo: { name: "projektor", version: "0.1.0" },
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
	...agentMessagesTools,
];

function jsonRpcResult(id: unknown, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

export { router as mcpRouter };
