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

/**
 * PROJ-889: how the caller authenticated, carried on every request context so usage
 * logging, per-operation scope checks and rate limits can key on the credential.
 *
 * - `access`: Cloudflare Access JWT (browser)      - `dev`: local dev bypass
 * - `public`: shared PUBLIC_READ_ONLY viewer        - `oauth`: OAuth grant (connector)
 * - `pk`: workspace API token (`pk_…`)             - `pat`: personal access token
 */
export type AuthMethod = "oauth" | "pk" | "pat" | "access" | "dev" | "public";

export interface AuthInfo {
	kind: "human" | "agent";
	method: AuthMethod;
	/** api_tokens.id for pk/pat, the grant id for oauth; absent for sessions. */
	credentialId?: string;
	/** OAuth client id (grants created after PROJ-889 only). */
	clientId?: string;
	/** Token/grant scopes; absent for sessions (governed by role only). */
	scopes?: string[];
}

/**
 * The context every service and MCP tool handler receives (apps/api's ServiceCtx is
 * this type). PROJ-889: MCP calls get the same full context as REST — including
 * waitUntil and the realtime hub — so MCP mutations broadcast like REST ones.
 */
export interface PluginContext {
	db: D1Database;
	kv: KVNamespace;
	r2: R2Bucket;
	workspaceId: string;
	userId: string;
	role?: Role;
	// PROJ-328: which auth path authenticated this request ("human" = Cloudflare Access
	// JWT / dev bypass, "agent" = Bearer API token or OAuth grant).
	authKind?: "human" | "agent";
	auth?: AuthInfo;
	workspaceHub?: DurableObjectNamespace;
	waitUntil?: (promise: Promise<unknown>) => void;
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
