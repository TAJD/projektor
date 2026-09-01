export interface Env {
	DB: D1Database;
	KV: KVNamespace;
	// PROJ-656/657: OAuth grants, authorization codes and access/refresh tokens.
	// The name is fixed by @cloudflare/workers-oauth-provider, which reads
	// env.OAUTH_KV directly rather than taking a binding as an option. Kept separate
	// from KV so clearing the cache namespace never revokes everyone's connectors.
	OAUTH_KV: KVNamespace;
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
	AUTO_JOIN_ROLE?: string; // role for non-admins CF admits: viewer|member|admin|owner|none (default none = invite-only)
	// Confine non-admin logins by email domain to a single workspace. JSON object:
	// {"example.com":{"slug":"example-team","role":"member"}}. Admins (ADMIN_EMAILS) bypass this.
	WORKSPACE_DOMAIN_MAP?: string;
	// Rate-limit tunables — override in wrangler.toml [vars] or as secrets.
	// Defaults: 10 req/window for IP-keyed (no bearer token), 120 for token-keyed.
	RATE_LIMIT_AUTH_MAX?: string; // max requests per IP per window when no bearer token is present
	RATE_LIMIT_API_MAX?: string; // max requests per token per window when a bearer token is present
	RATE_LIMIT_WINDOW_SECS?: string; // window size in seconds (default 60)
	RATE_LIMIT_AUTH_FAIL_MAX?: string; // max failed bearer-token auths per IP per window before 429 (default 50)
	// PROJ-378: public feedback-submit rate limiting. Dedicated from RATE_LIMIT_API_MAX/
	// RATE_LIMIT_AUTH_MAX (which govern authenticated API/auth traffic) because the
	// submit route runs outside the global rateLimitMiddleware chain entirely and
	// anonymous feedback-spam must not share a budget with authenticated callers.
	RATE_LIMIT_FEEDBACK_MAX?: string; // max submissions per source token per window (default 30)
	RATE_LIMIT_FEEDBACK_IP_MAX?: string; // max submissions per IP per window (default 100)
	// Per-workspace attachment storage quota in bytes (default 1 GiB). Override in
	// wrangler.toml [vars]; invalid or non-positive values fall back to the default.
	STORAGE_QUOTA_BYTES?: string;
	// Comma-separated allowlist of browser origins permitted for cross-origin
	// requests (CORS). The served SPA is same-origin, so it never needs this;
	// set it only when a browser app on a DIFFERENT origin calls this API.
	// Unset/empty = no cross-origin browser access (non-browser bearer clients
	// are unaffected — CORS only constrains browsers). (PROJ-203)
	CORS_ALLOWED_ORIGINS?: string;
	// Static assets binding (production wrangler.toml only — absent in local dev).
	ASSETS?: Fetcher;
	// Resolve the workspace from the Host header's first label when X-Workspace-Slug
	// is absent (e.g. team.example.com -> slug "team"). Off by default: most deployments
	// sit behind a single Cloudflare Workers hostname, where the leading label is a
	// CDN/proxy artifact, not a real tenant signal. Set "true" only when workspace
	// subdomains are actually provisioned in DNS. Honored truthy values (case-
	// insensitive, whitespace-trimmed): "true", "1", "yes". (PROJ-267, PROJ-296)
	WORKSPACE_SUBDOMAIN_ROUTING?: string;
	// PROJ-373: explicit opt-in. When truthy, anonymous requests (no CF Access
	// session, no bearer token) are treated as a shared read-only "viewer" of the
	// default workspace, instead of 401ing. Off by default — an operator who
	// hasn't configured CF_ACCESS_TEAM_DOMAIN yet must NOT have their instance
	// silently become world-readable; this only applies when explicitly set.
	// Independent of whether CF Access is configured. Honored truthy values
	// (case-insensitive, whitespace-trimmed): "true", "1", "yes".
	PUBLIC_READ_ONLY?: string;
	// Optional: opt-in real-time WebSocket hub (Durable Objects). Omitted for
	// free-tier/1-click deployments; present when opt-in real-time features are enabled.
	WORKSPACE_HUB?: DurableObjectNamespace;
}

export interface RealtimeEvent<T = unknown> {
	type: string;
	workspaceId: string;
	projectId?: string | null;
	data: T;
	timestamp: number;
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
	// PROJ-328: the authenticated principal type, derived from which auth path fired
	// (Cloudflare Access / dev bypass => "human", Bearer API token => "agent") — not a
	// caller-declared field like the deprecated agent_sessions.kind (PROJ-336).
	authKind: "human" | "agent";
	// PROJ-494: opt-in, set by index.ts ahead of workspaceMiddleware for GET requests
	// that a browser subresource load (e.g. an <img> tag rendering an inline attachment)
	// can't attach a custom X-Workspace-Slug header to. See middleware/workspace.ts.
	allowQueryWorkspaceFallback: boolean | undefined;
}

export type HonoEnv = { Bindings: Env; Variables: Variables };
