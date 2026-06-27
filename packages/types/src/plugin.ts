export interface Migration {
	version: number;
	sql: string;
}

export interface MCPTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (input: unknown, ctx: PluginContext) => Promise<unknown>;
}

export interface PluginContext {
	db: D1Database;
	kv: KVNamespace;
	r2: R2Bucket;
	workspaceId: string;
	userId: string;
	role?: Role;
}

export interface Plugin {
	id: string;
	name: string;
	version: string;
	migrations?: Migration[];
	// biome-ignore lint/suspicious/noExplicitAny: Hono app type not available in this package
	register?: (app: any) => void;
	mcpTools?: MCPTool[];
}

export type Role = "owner" | "admin" | "member" | "viewer";
