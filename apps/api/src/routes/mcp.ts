import type { HonoEnv, MCPTool, PluginContext, Role } from "@projektor/types";
import { Hono } from "hono";
import { capabilityForMcpTool, tokenAllows } from "../auth/scopes";
import { agentMessagesTools } from "../mcp/agent-messages";
import { agentsTools } from "../mcp/agents";
import { codeHeatmapTools } from "../mcp/code-heatmap";
import { commentsTools } from "../mcp/comments";
import { customFieldsTools } from "../mcp/custom-fields";
import { toMcpError } from "../mcp/error-adapter";
import { feedbackTools } from "../mcp/feedback";
import { fileClaimsTools } from "../mcp/file-claims";
import { filesTools } from "../mcp/files";
import { flowMetricsTools } from "../mcp/flow-metrics";
import { groupsTools } from "../mcp/groups";
import { issueLeasesTools } from "../mcp/issue-leases";
import { issueLinksTools } from "../mcp/issue-links";
import { issuesTools } from "../mcp/issues";
import { projectActivityTools } from "../mcp/project-activity";
import { projectsTools } from "../mcp/projects";
import { sprintsTools } from "../mcp/sprints";
import { taskStatusesTools } from "../mcp/task-statuses";
import { taskTypesTools } from "../mcp/task-types";
import { wikiTools } from "../mcp/wiki";
import { workflowTools } from "../mcp/workflow";
import { workspacesTools } from "../mcp/workspaces";
import { pluginRegistry } from "../plugins/registry";

// __PROJEKTOR_VERSION__ is injected by esbuild --define at release-build time
// (scripts/build-release.sh); it's absent in local `wrangler dev` and tests.
// The dogfood deploy (local wrangler-OAuth post-commit hook, outside this repo) also
// skips build-release.sh, so dogfood intentionally reports "dev" here - only versioned
// release tarballs carry a real version string.
const SERVER_VERSION = typeof __PROJEKTOR_VERSION__ === "string" ? __PROJEKTOR_VERSION__ : "dev";

// PROJ-454: tools/list cache hint (2026-07-28 spec's cacheable-list-responses
// addition, SEP-2549). The plugin registry has no change hook to invalidate
// on, so this is a conservative TTL rather than an exact bound.
const TOOLS_LIST_TTL_MS = 60_000;

// "private" (HTTP Cache-Control semantics, not a projektor-specific value):
// only the requesting client may cache this response, not a shared
// intermediary. Correct today because tools/list is NOT filtered by token
// scope or role (only tools/call is, below) — every caller in a workspace
// sees the same list. If list filtering is ever added, this must become
// per-identity, not just per-workspace, or a shared cache would leak one
// caller's tool set to another.
const TOOLS_LIST_CACHE_SCOPE = "private";

// Surfaced to every MCP client at `initialize` (the MCP spec's optional
// `instructions` field). Clients like Claude Code inject this into the model's
// context. Deliberately a one-paragraph pointer, not a restatement of the rules —
// the workflow spec (definition of ready, state machine, human gates, WIP limits,
// fleet coordination) has exactly one home: call `get_workflow` (or see
// apps/docs/src/content/docs/agents/workflow-spec.md).
const SERVER_INSTRUCTIONS =
	"Projektor is an MCP-native issue tracker + wiki. Every project-management action a browser user can do " +
	'is available here as a tool. Handy entry points: get_issue accepts a ref like "PROJ-42"; ' +
	'get_prioritized_issues answers "what should I work on next?"; search_issues / search_wiki ground you in ' +
	"existing context. Call get_workflow before claiming work — it returns the definition of ready, the state " +
	"machine, human review gates, and fleet coordination rules.";

const router = new Hono<HonoEnv>();

// MCP endpoint: POST /mcp/{workspaceId}
// Implements JSON-RPC 2.0 over HTTP (MCP Streamable HTTP transport)
//
// This is a "legacy-era" server per the 2026-07-28 spec's versioning model:
// it still uses the initialize handshake rather than per-request `_meta`
// (io.modelcontextprotocol/protocolVersion etc.) and has no server/discover
// endpoint. That's fine — it was already stateless in practice (no session
// store, no Mcp-Session-Id, no requirement that `initialize` precede other
// calls; every request carries everything it needs from the URL/auth
// headers) and legacy-to-legacy is a fully supported combination. Adopting
// the "modern" per-request-metadata era is real protocol surface, not a
// bump — tracked separately, not attempted here. See PROJ-452 and
// docs/superpowers/specs/2026-07-29-mcp-2026-07-28-update-plan.md.
router.post("/:workspaceId", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };
	const role = c.get("role") as Role | undefined;
	const authKind = c.get("authKind") as "human" | "agent" | undefined;
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
		authKind,
	};

	switch (body.method) {
		case "initialize":
			// "2025-11-25" is the latest *legacy* (initialize-handshake) protocol
			// version, not "2026-07-28" — that string denotes the modern per-request
			// `_meta` era, which has no `initialize` method at all. Claiming it here
			// while still running the legacy handshake would be spec-incoherent.
			return c.json(
				jsonRpcResult(body.id, {
					protocolVersion: "2025-11-25",
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
					// PROJ-454: the tool list is workspace-scoped (core tools + the
					// plugin registry's tools for this workspace) and changes rarely,
					// so a short client-side cache is safe.
					ttlMs: TOOLS_LIST_TTL_MS,
					cacheScope: TOOLS_LIST_CACHE_SCOPE,
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
				const { code, message, data } = toMcpError(err);
				return c.json(jsonRpcError(body.id, code, message, data));
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
	...groupsTools,
	...projectsTools,
	...projectActivityTools,
	...issuesTools,
	...issueLinksTools,
	...commentsTools,
	...feedbackTools,
	...wikiTools,
	...filesTools,
	...taskTypesTools,
	...taskStatusesTools,
	...customFieldsTools,
	...sprintsTools,
	...agentsTools,
	...fileClaimsTools,
	...issueLeasesTools,
	...agentMessagesTools,
	...workflowTools,
	...flowMetricsTools,
	...codeHeatmapTools,
];

function jsonRpcResult(id: unknown, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown) {
	// cofferdam-ignore: Consistency.ErrorHandlingIdiom: this returns a JSON-RPC error object per spec (jsonrpc 2.0), not a code-style error-shaped return
	// `data` is the JSON-RPC 2.0 spec's optional error.data member — omitted entirely
	// (not sent as `null`/`undefined`) when the error has no structured payload.
	return {
		jsonrpc: "2.0",
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}

export { router as mcpRouter };
