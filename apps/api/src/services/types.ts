import type { AuthInfo, HonoEnv, PluginContext, Role } from "@projektor/types";
import type { Context } from "hono";

// PROJ-889: one context type for REST and MCP — defined in @projektor/types as
// PluginContext (so MCPTool handlers receive it without casts) and aliased here.
export type ServiceCtx = PluginContext;

export function ctxFromHono(c: Context<HonoEnv>): ServiceCtx {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };
	const role = c.get("role") as Role | undefined;
	const authKind = c.get("authKind") as "human" | "agent" | undefined;
	return {
		db: c.env.DB,
		kv: c.env.KV,
		r2: c.env.R2,
		workspaceId: workspace.id,
		userId: user.id,
		role,
		authKind,
		auth: c.get("auth") as AuthInfo | undefined,
		workspaceHub: c.env.WORKSPACE_HUB,
		waitUntil: c.executionCtx?.waitUntil ? (p) => c.executionCtx.waitUntil(p) : undefined,
	};
}
