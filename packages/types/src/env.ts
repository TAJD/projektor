export interface Env {
	DB: D1Database;
	KV: KVNamespace;
	R2: R2Bucket;
	JWT_SECRET: string;
	ENVIRONMENT: "development" | "staging" | "production";
	CF_ACCESS_TEAM_DOMAIN: string;
	CF_ACCESS_AUDIENCE: string;
	DEV_USER_EMAIL?: string;
	// Set this secret to enable /bootstrap in development; if unset the endpoint is disabled.
	BOOTSTRAP_SECRET?: string;
	// Login provisioning (see services/provisioning.ts). Runs on every Cloudflare Access
	// (browser) login. Cloudflare Access is the gate; these decide what a user gets inside.
	ADMIN_EMAILS?: string; // comma-separated; these emails become workspace owners
	DEFAULT_WORKSPACE_SLUG?: string; // default 'projektor' (matches the workers.dev subdomain)
	DEFAULT_WORKSPACE_NAME?: string; // default 'Projektor'
	AUTO_JOIN_ROLE?: string; // role for non-admins CF admits: viewer|member|admin|owner|none (default viewer)
	// Confine non-admin logins by email domain to a single workspace. JSON object:
	// {"example.com":{"slug":"example-team","role":"member"}}. Admins (ADMIN_EMAILS) bypass this.
	WORKSPACE_DOMAIN_MAP?: string;
	// Rate-limit tunables — override in wrangler.toml [vars] or as secrets.
	// Defaults: 10 req/window for IP-keyed (no bearer token), 120 for token-keyed.
	RATE_LIMIT_AUTH_MAX?: string; // max requests per IP per window when no bearer token is present
	RATE_LIMIT_API_MAX?: string; // max requests per token per window when a bearer token is present
	RATE_LIMIT_WINDOW_SECS?: string; // window size in seconds (default 60)
	// Static assets binding (production wrangler.toml only — absent in local dev).
	ASSETS?: Fetcher;
}

export interface Variables {
	user: { id: string; email: string; name: string };
	workspace: { id: string; name: string; slug: string };
	role: string;
	// undefined = CF Access / dev-bypass auth (no token); null = user-scoped token; string = workspace-scoped token
	tokenWorkspaceId: string | null | undefined;
	// Scopes carried by an API token (PROJ-17). Undefined when auth came from a
	// Cloudflare Access session or the dev bypass — those are governed by member
	// role only, not by token scope.
	tokenScopes: string[] | undefined;
}

export type HonoEnv = { Bindings: Env; Variables: Variables };
