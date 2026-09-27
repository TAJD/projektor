import type { Env, HonoEnv } from "@projektor/types";
import { buildMcpAddCommand } from "@projektor/types";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { jsonBody } from "./http/body";
import { serviceErrToResponse } from "./http/error-adapter";
import { safeDecodeURIComponent } from "./lib/urls";
import { injectWikiMetadata, resolveWikiPageForSsr } from "./lib/wiki-ssr";
import { authMiddleware } from "./middleware/auth";
import { etagMiddleware } from "./middleware/etag";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { workspaceMiddleware } from "./middleware/workspace";
import {
	createOAuthProvider,
	isOAuthAccessToken,
	isOAuthProviderPath,
	tokenEndpointRateLimited,
} from "./oauth/provider";
import { agentMessagesRouter } from "./routes/agent-messages";
import { agentsRouter } from "./routes/agents";
import { authRouter } from "./routes/auth";
import { codeHeatmapRouter } from "./routes/code-heatmap";
import { commentsRouter } from "./routes/comments";
import { configRouter } from "./routes/config";
import { customFieldsRouter } from "./routes/custom-fields";
import { feedbackPublicRouter, feedbackRouter } from "./routes/feedback";
import { feedbackSourceLookupRouter, feedbackSourcesRouter } from "./routes/feedback-sources";
import { fileClaimsRouter } from "./routes/file-claims";
import { filesRouter } from "./routes/files";
import { flowMetricsRouter } from "./routes/flow-metrics";
import { groupsRouter } from "./routes/groups";
import { issueLinksRouter } from "./routes/issue-links";
import { issuesRouter } from "./routes/issues";
import { mcpRouter } from "./routes/mcp";
import { oauthRouter } from "./routes/oauth";
import { oauthMetadataRouter } from "./routes/oauth-metadata";
import { playbooksRouter } from "./routes/playbooks";
import { projectActivityRouter } from "./routes/project-activity";
import { projectsRouter } from "./routes/projects";
import { realtimeRouter } from "./routes/realtime";
import { shareIssuesRouter, sharePublicRouter } from "./routes/share";
import { sprintsRouter } from "./routes/sprints";
import { taskStatusesRouter } from "./routes/task-statuses";
import { taskTypesRouter } from "./routes/task-types";
import { wikiRouter } from "./routes/wiki";
import { workflowRouter } from "./routes/workflow";
import { workspacesRouter } from "./routes/workspaces";
import { seedDefaultCustomFields } from "./services/custom-fields";
import { ServiceError } from "./services/errors";
import { listProjectsAcrossWorkspaces } from "./services/projects";
import { seedDefaultTaskStatuses } from "./services/task-statuses";
import { seedDefaultTaskTypes } from "./services/task-types";
import type { ServiceCtx } from "./services/types";
import { purgeExpiredWikiPages, WIKI_TRASH_RETENTION_SECONDS } from "./services/wiki";
import { createWorkspace, listWorkspaces } from "./services/workspaces";

const app = new Hono<HonoEnv>();

// PROJ-430: Hono's default handler answers an uncaught throw with a bare,
// unlogged 500, which is why diagnosing the overnight error burst needed
// temporary instrumentation (PROJ-427/#131). Log the failure with its request
// context and return the same JSON error shape every other endpoint uses.
app.onError((err, c) => {
	// PROJ-877: a typed service error that escaped a route's try (e.g. a body parse
	// outside it) still maps to its 4xx rather than a 500.
	if (err instanceof ServiceError) return serviceErrToResponse(c, err);
	console.error("unhandled error", {
		method: c.req.method,
		path: c.req.path,
		err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	});
	return c.json({ error: "Internal Server Error" }, 500);
});

// PROJ-378: anonymous feedback ingestion. Mounted ahead of the global logger()
// and cors() calls below — not merely ahead of auth — the same "register before
// the .use() you need to skip" technique already used for /api/health (mounted
// ahead of the /api/* rateLimitMiddleware .use() further down so health checks
// stay unrate-limited). The global cors() is an allowlist that by design excludes
// third-party feedback origins and would otherwise short-circuit the OPTIONS
// preflight; the route verifies the source's own token inline and owns its
// per-source CORS instead. It also loses the global logger() this way, so
// feedbackPublicRouter applies its own scoped logger() (see routes/feedback.ts).
app.route("/api/feedback", feedbackPublicRouter);

app.use("*", logger());
// CORS is an allowlist, not "*" (PROJ-203). The served SPA is same-origin, so it
// is unaffected by CORS; this only governs cross-origin *browser* clients. Set
// CORS_ALLOWED_ORIGINS (comma-separated) to permit a browser app on another
// origin. Unset/empty = deny cross-origin. Non-browser bearer clients never send
// an Origin header and so are never constrained here.
app.use(
	"*",
	cors({
		origin: (origin, c) => {
			const allowed = ((c.env as Env).CORS_ALLOWED_ORIGINS ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			return allowed.includes(origin) ? origin : null;
		},
		allowHeaders: ["Authorization", "Content-Type", "Cf-Access-Jwt-Assertion", "X-Workspace-Slug"],
	})
);

app.get("/health", (c) => c.json({ ok: true }));
// Same probe under /api so the served frontend (same-origin /api/*) can reach it.
// Registered before the /api/* rate-limit + auth so it stays an open health check.
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/config", configRouter);

// Rate-limit all API and MCP traffic ahead of auth and heavy handlers.
// Keyed by bearer-token fingerprint when present, else by CF-Connecting-IP.
// Limits are read from RATE_LIMIT_AUTH_MAX / RATE_LIMIT_API_MAX env vars.
app.use("/api/*", rateLimitMiddleware);
app.use("/mcp/*", rateLimitMiddleware);
// PROJ-655: the OAuth discovery documents are unauthenticated and are the first
// thing every MCP client hits, so they get the same IP-keyed limiter. Mounted here,
// above the auth/workspace middleware, because they must stay public.
app.use("/.well-known/*", rateLimitMiddleware);
app.route("/.well-known", oauthMetadataRouter);
// PROJ-656: the consent screen. authMiddleware runs so the page knows who is
// consenting — but no workspaceMiddleware: the workspace comes from the request's
// RFC 8707 `resource` parameter, not from a header or a path prefix, and the route
// resolves and authorises it itself (services/oauth.ts).
app.use("/oauth/*", rateLimitMiddleware);
app.use("/oauth/*", authMiddleware);
app.route("/oauth", oauthRouter);

// Bootstrap — non-production only. Creates workspace + user + API token in one shot.
// Returns everything needed to start using the MCP endpoint immediately.
app.get("/bootstrap", async (c) => {
	// Fail-closed: only allow in an explicit development environment.
	// Treat any unset/unknown value as production to avoid accidental exposure.
	if (c.env.ENVIRONMENT !== "development") {
		return c.json({ error: "Not available in production" }, 403);
	}
	// Require the setup secret to be both configured and correctly provided.
	const secret = c.env.BOOTSTRAP_SECRET;
	if (!secret) {
		return c.json({ error: "Not available" }, 403);
	}
	const provided = c.req.header("X-Bootstrap-Secret") ?? c.req.query("setup_secret");
	if (provided !== secret) {
		return c.json({ error: "Forbidden" }, 403);
	}

	const email = c.env.DEV_USER_EMAIL ?? "admin@projektor.dev";
	const now = Math.floor(Date.now() / 1000);

	// Upsert user
	const userId = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name`
	)
		.bind(userId, email, email.split("@")[0], now)
		.run();
	const user = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string; email: string; name: string }>();

	// Upsert workspace
	const wsId = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, 'projektor', 'projektor', ?)
     ON CONFLICT(slug) DO NOTHING`
	)
		.bind(wsId, now)
		.run();
	const ws = await c.env.DB.prepare("SELECT id, name, slug FROM workspaces WHERE slug = ?")
		.bind("projektor")
		.first<{ id: string; name: string; slug: string }>();

	// Upsert membership
	await c.env.DB.prepare(
		`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
     ON CONFLICT(workspace_id, user_id) DO NOTHING`
	)
		.bind(ws?.id, user?.id, now)
		.run();

	// Seed default task types, statuses, and custom fields (idempotent)
	// biome-ignore lint/style/noNonNullAssertion: ws was just upserted above; SELECT after guarantees it exists
	await seedDefaultTaskTypes(c.env.DB, ws!.id);
	// biome-ignore lint/style/noNonNullAssertion: ws was just upserted above; SELECT after guarantees it exists
	await seedDefaultTaskStatuses(c.env.DB, ws!.id);
	// biome-ignore lint/style/noNonNullAssertion: ws was just upserted above; SELECT after guarantees it exists
	await seedDefaultCustomFields(c.env.DB, ws!.id);

	// Generate token
	const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
	const token =
		"pk_" +
		Array.from(tokenBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	const hash = await sha256hex(token);
	const tokenId = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, scopes, created_at)
     VALUES (?, ?, ?, 'bootstrap', ?, '["read","write"]', ?)`
	)
		.bind(tokenId, ws?.id, user?.id, hash, now)
		.run();

	const origin = new URL(c.req.url).origin;
	const mcpUrl = `${origin}/mcp/${ws?.id}`;

	return c.json({
		workspace: ws,
		user,
		token,
		mcpUrl,
		mcpAddCommand: buildMcpAddCommand({ workspaceSlug: ws?.slug ?? "", mcpUrl, token }),
	});
});

// Public share route — MUST be before auth middleware
app.route("/api/share", sharePublicRouter);

// Public auth routes
app.route("/auth", authRouter);

// Workspace list + create — auth only, no workspace context
app.get("/api/workspaces", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	return c.json(await listWorkspaces(c.env.DB, user.id));
});

app.post("/api/workspaces", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	try {
		return c.json(await createWorkspace(c.env.DB, user.id, await jsonBody(c)), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// All remaining /api/* and /mcp/* routes need auth + workspace context.
// PROJ-856: register each prefix ONCE, as `/x/*`. Hono's `/x/*` also matches the bare
// `/x`, so adding a separate `app.use("/x", …)` ran auth + workspace twice (two wasted
// sequential D1 round trips per request). test/middleware-once.test.ts guards this.
app.use("/api/workspaces/:slug/*", authMiddleware, workspaceMiddleware);
// Cross-workspace project list — auth only, no workspace context needed
app.get("/api/projects", authMiddleware, etagMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	const includeArchived = c.req.query("includeArchived") === "true";
	try {
		return c.json(await listProjectsAcrossWorkspaces(user.id, c.env.DB, includeArchived));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});
// Project mutations and /:id routes need workspace context
app.use("/api/projects/*", authMiddleware, workspaceMiddleware);
app.use("/api/issues/*", authMiddleware, workspaceMiddleware);
app.use("/api/issue-links/*", authMiddleware, workspaceMiddleware);
app.use("/api/wiki/*", authMiddleware, workspaceMiddleware);
app.use("/mcp/*", authMiddleware, workspaceMiddleware);
// PROJ-494: an inline image embedded in rendered wiki content (`<img src="/api/files/:id?workspace=...">`)
// is a plain browser subresource load — it can't attach the X-Workspace-Slug header apiFetch
// normally sends, so GET here also accepts `?workspace=` as a resolution fallback (see
// middleware/workspace.ts). Scoped to GET only; POST/DELETE always go through apiFetch, which
// already sends the header.
const allowFilesQueryWorkspaceFallback = async (c: Context<HonoEnv>, next: Next) => {
	if (c.req.method === "GET") c.set("allowQueryWorkspaceFallback", true);
	await next();
};
app.use("/api/files/*", allowFilesQueryWorkspaceFallback);
app.use("/api/files/*", authMiddleware, workspaceMiddleware);
app.use("/api/task-types/*", authMiddleware, workspaceMiddleware);
app.use("/api/task-statuses/*", authMiddleware, workspaceMiddleware);
app.use("/api/custom-fields/*", authMiddleware, workspaceMiddleware);
app.use("/api/sprints/*", authMiddleware, workspaceMiddleware);
app.use("/api/agents/*", authMiddleware, workspaceMiddleware);
app.use("/api/file-claims/*", authMiddleware, workspaceMiddleware);
app.use("/api/agent-messages/*", authMiddleware, workspaceMiddleware);
app.use("/api/feedback-sources/*", authMiddleware, workspaceMiddleware);
// No workspaceMiddleware: the workflow spec is global, not workspace-scoped.
app.use("/api/workflow/*", authMiddleware);
app.use("/api/playbooks/*", authMiddleware);
// PROJ-633: compose is the one exception to the line above. Reading a playbook is a pure
// function of static templates, but composing one resolves a live epic, so it needs
// workspace context. Scoped to this single path rather than the whole prefix: applying
// workspaceMiddleware to `/api/playbooks/*` would make GET /api/playbooks and
// GET /api/playbooks/:name start returning 400 without an X-Workspace-Slug header, which
// is a breaking change to two endpoints that are deliberately global.
app.use("/api/playbooks/:name/compose", workspaceMiddleware);

// PROJ-439: conditional GETs on the read-heavy JSON routes. Registered *after* the
// auth/workspace .use() calls above so an unauthorised request short-circuits before
// this ever runs — a 304 must never be returned where a 401/403/404 belongs.
// Not applied to /api/files/*: GET /api/files/:id streams an R2 object, and buffering
// it to hash would trade a bandwidth saving for a memory and latency cost.
// The cross-workspace project list is registered further up, ahead of these .use()
// calls, so a .use() here would never wrap it — it takes the middleware inline instead.
app.use("/api/issues/*", etagMiddleware);
app.use("/api/task-statuses", etagMiddleware);

app.route("/api/workspaces", workspacesRouter);
app.route("/api/workspaces", groupsRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/projects", flowMetricsRouter);
app.route("/api/projects", codeHeatmapRouter);
app.route("/api/projects", projectActivityRouter);
app.route("/api/projects", feedbackSourcesRouter);
app.route("/api/feedback-sources", feedbackSourceLookupRouter);
app.route("/api/projects", feedbackRouter);
app.route("/api/issues", issuesRouter);
app.route("/api/issues", issueLinksRouter);
app.route("/api/issues", commentsRouter);
app.route("/api/issues", shareIssuesRouter);
app.route("/api/wiki", wikiRouter);
app.route("/mcp", mcpRouter);
app.route("/api/files", filesRouter);
app.route("/api/task-types", taskTypesRouter);
app.route("/api/task-statuses", taskStatusesRouter);
app.route("/api/custom-fields", customFieldsRouter);
app.route("/api/sprints", sprintsRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/file-claims", fileClaimsRouter);
app.route("/api/agent-messages", agentMessagesRouter);
app.route("/api/workflow", workflowRouter);
app.route("/api/playbooks", playbooksRouter);
app.route("/api", realtimeRouter);

// PROJ-487 fix-up: /wiki is a static asset (wiki/index.html) that Cloudflare serves
// directly without ever invoking the Worker — so the legacy `?slug=` query param can
// only be turned into a real HTTP redirect if this exact path is added to
// `run_worker_first` in the wrangler config (see scripts/release-assets/wrangler.example.toml).
// With that in place, this handler issues a genuine 301 to the canonical /wiki/:slug
// path (resolving through PROJ-483's slug/redirect logic, so a stale slug redirects
// straight to the current one rather than chaining). If the request can't be
// authenticated/scoped to a workspace (e.g. no session, or a deployment with no
// resolvable workspace for a bare navigation), this falls back to serving the plain
// landing page rather than erroring — the client-side WikiPage island still handles
// `?slug=` today as a fallback.
app.get("/wiki", async (c) => {
	const assets = c.env.ASSETS;
	if (!assets) return c.notFound();
	const legacySlug = c.req.query("slug");
	const shell = () => assets.fetch(new Request(new URL("/wiki/index.html", c.req.url).toString()));
	if (!legacySlug) return shell();

	const page = await resolveWikiPageForSsr(c, legacySlug);
	if (!page) return shell();
	return c.redirect(page.url, 301);
});

// SPA fallback — paths with no matching static asset fall through here.
// Only active in production where the ASSETS binding is present.
// Issue pretty-URL paths (/projects/KEY/issues/N/title-slug) get the issue-detail
// page so its IssueDetail island can resolve the issue from the URL path client-side.
// Project pretty-URL paths (/projects/view/<slug>, PROJ-376) get the project-view
// page so its ProjectLanding/ProjectNav islands can resolve it the same way.
// Wiki pretty-URL paths (/wiki/:slug, PROJ-487) get the wiki-view page so its
// WikiPage island can resolve the page from the URL path client-side — /wiki itself
// (no slug) is handled by the dedicated route above and never reaches this fallback.
// Everything else gets the homepage.
app.get("*", async (c) => {
	if (!c.env.ASSETS) return c.notFound();
	const { pathname } = new URL(c.req.url);
	const wikiSlugMatch = /^\/wiki\/([^/]+)\/?$/.exec(pathname);
	const fallbackPath = /^\/projects\/[^/]+\/issues\/\d+\//.test(pathname)
		? "/issues/view/index.html"
		: /^\/projects\/view\/[^/]+/.test(pathname)
			? "/projects/view/index.html"
			: /^\/share\//.test(pathname)
				? "/share/view/index.html"
				: /^\/feedback\/[^/]+/.test(pathname)
					? "/feedback/view/index.html"
					: wikiSlugMatch
						? "/wiki/view/index.html"
						: "/index.html";
	const response = await c.env.ASSETS.fetch(
		new Request(new URL(fallbackPath, c.req.url).toString())
	);
	// PROJ-487 fix-up: best-effort server-injected <title>/OG metadata for a resolved,
	// authenticated wiki page — see lib/wiki-ssr.ts for why this can't be a build-time
	// Astro SSR adapter, and why it's scoped to authenticated requests only (the wiki
	// has no public/unauthenticated share path — see the PRD's public-wiki-sharing
	// non-goal, PROJ-482). Any failure here just serves the unmodified static shell.
	// PROJ-512: a malformed percent-escape (e.g. `/wiki/100%`) makes decodeURIComponent
	// throw — treat that as "can't resolve a slug" rather than letting it 500 past this
	// point, since `response` (the static shell) is already fetched and ready to serve.
	if (wikiSlugMatch) {
		const decodedSlug = safeDecodeURIComponent(wikiSlugMatch[1]);
		const page = decodedSlug ? await resolveWikiPageForSsr(c, decodedSlug) : null;
		if (page) return injectWikiMetadata(response, page, new URL(pathname, c.req.url).toString());
	}
	return response;
});

async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// PROJ-496: daily Workers Cron Trigger (see [triggers].crons in wrangler.toml) for the
// 30-day wiki trash purge. purgeExpiredWikiPages is workspace-scoped and requires an
// admin/owner role, so this iterates every workspace and runs it as a synthetic owner
// ctx — there's no authenticated user in a cron invocation, so userId is a placeholder
// (purgeExpiredWikiPages never reads it). A failure purging one workspace is logged and
// does not stop the sweep over the rest.
export async function scheduled(
	_controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext
): Promise<void> {
	ctx.waitUntil(purgeAllWorkspacesExpiredWikiPages(env));
	ctx.waitUntil(purgeExpiredOAuthData(env));
	ctx.waitUntil(purgeExpiredRetentionData(env));
	ctx.waitUntil(runFtsDedupeOnce(env));
}

// PROJ-816 follow-up: migration 0065 rebuilt wiki_fts keyed by wiki_pages.search_rowid, but
// worker instances still running the pre-0065 code during the deploy window kept inserting
// FTS rows the old way (SQLite auto-assigned rowid, no search_rowid link) until they rolled
// over. Those stray rows are never found by search_rowid-based lookups, so the ordinary
// delete-before-insert path (deleteWikiFtsEntries) can't clean them up — a one-off sweep is
// the only way to remove them. Guarded by a KV flag so it runs exactly once ever, not once
// per cron fire: after 0065 has fully rolled out there's nothing left for it to find, and
// running `DELETE ... NOT IN (SELECT ...)` against the whole wiki_fts table on every daily
// fire forever would be pure waste.
const FTS_DEDUPE_ONCE_KV_KEY = "maint:fts-dedupe-0065";

export async function runFtsDedupeOnce(env: Env): Promise<void> {
	try {
		const alreadyRan = await env.KV.get(FTS_DEDUPE_ONCE_KV_KEY);
		if (alreadyRan) return;
		// Pages old code created during the deploy window have no search_rowid; adopt their
		// existing FTS row's rowid first so the dedupe below doesn't drop them from search.
		await env.DB.prepare(
			`UPDATE OR IGNORE wiki_pages SET search_rowid = (
			   SELECT MAX(rowid) FROM wiki_fts WHERE page_id = wiki_pages.id)
			 WHERE search_rowid IS NULL`
		).run();
		const result = await env.DB.prepare(
			"DELETE FROM wiki_fts WHERE rowid NOT IN (SELECT search_rowid FROM wiki_pages WHERE search_rowid IS NOT NULL)"
		).run();
		await env.KV.put(FTS_DEDUPE_ONCE_KV_KEY, "1");
		console.log("one-off wiki_fts dedupe complete (PROJ-816)", {
			deleted: result.meta.changes ?? 0,
		});
	} catch (err) {
		console.error("one-off wiki_fts dedupe failed (PROJ-816)", {
			err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		});
	}
}

// PROJ-869: retention for tables that grow forever and are never pruned otherwise —
// wiki_notifications, ended agent_sessions (that no issue_leases row references — see
// below), and the activity log. wiki_revisions is deliberately left untouched (page
// history is a product decision, not covered by this ticket).
//
// issue_leases is deliberately NEVER pruned by age (post-review correction to this
// ticket): flow metrics (get_flow_metrics) read issue_leases for lease-held time and lease
// expiries, so deleting a released lease after 90 days would silently zero out autonomy
// ratio, flow efficiency and lease-expiry counts for any reporting window older than that.
// There is no env var for this category — it isn't a knob, it's "never".
//
// Each category runs a small, independent `DELETE ... WHERE rowid IN (SELECT rowid ...
// LIMIT chunkSize)` loop rather than one unbounded DELETE: a workspace that's never had
// this cron run before could have years of backlog, and a single DELETE over all of it
// risks the invocation's CPU/time budget. `RETENTION_CHUNK_SIZE` rows per statement,
// up to `RETENTION_MAX_CHUNKS_PER_CATEGORY` statements per category per invocation — if a
// category still has more expired rows than that after one run, it simply continues
// making progress on the next scheduled run (the WHERE clause always targets the oldest
// remaining expired rows, so this needs no separate cursor to resume from).
//
// Global (not workspace-scoped): these tables hold no cross-tenant secret by their age
// alone, and the tables are internal housekeeping, not something the workspace-scoping
// invariant (AGENTS.md) applies to for a delete-by-age sweep.
const RETENTION_CHUNK_SIZE = 500;
const RETENTION_MAX_CHUNKS_PER_CATEGORY = 20;

function retentionCutoff(raw: string | undefined, defaultDays: number): number {
	const days = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
	const effectiveDays = Number.isFinite(days) && days > 0 ? days : defaultDays;
	return Math.floor(Date.now() / 1000) - effectiveDays * 86400;
}

async function deleteExpiredInChunks(
	db: D1Database,
	table: string,
	whereSql: string,
	params: readonly unknown[]
): Promise<number> {
	let totalDeleted = 0;
	for (let i = 0; i < RETENTION_MAX_CHUNKS_PER_CATEGORY; i++) {
		const result = await db
			.prepare(
				`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${whereSql} LIMIT ?)`
			)
			.bind(...params, RETENTION_CHUNK_SIZE)
			.run();
		const changes = result.meta.changes ?? 0;
		totalDeleted += changes;
		if (changes < RETENTION_CHUNK_SIZE) break;
	}
	return totalDeleted;
}

export async function purgeExpiredRetentionData(env: Env): Promise<void> {
	const notificationCutoff = retentionCutoff(env.WIKI_NOTIFICATION_RETENTION_DAYS, 90);
	const sessionCutoff = retentionCutoff(env.AGENT_SESSION_RETENTION_DAYS, 90);
	const activityCutoff = retentionCutoff(env.ACTIVITY_RETENTION_DAYS, 365);

	const counts: Record<string, number> = {};
	const failures: string[] = [];

	const categories: Array<{ name: string; table: string; whereSql: string; params: unknown[] }> = [
		{
			name: "wiki_notifications",
			table: "wiki_notifications",
			whereSql: "created_at < ?",
			params: [notificationCutoff],
		},
		{
			name: "agent_sessions",
			// PROJ-869: only a session no issue_leases row references — flow metrics can still
			// read a referenced session's lease-held time and expiries however old the session
			// is. The FK from issue_leases.agent_session_id is CASCADE and D1 does enforce FKs
			// (verified in PROJ-923), so with this clause no session this deletes ever has a
			// lease to begin with — the detach block below no longer needs to touch issue_leases.
			table: "agent_sessions",
			whereSql: `status = 'ended' AND ended_at IS NOT NULL AND ended_at < ?
				AND NOT EXISTS (SELECT 1 FROM issue_leases l WHERE l.agent_session_id = agent_sessions.id)`,
			params: [sessionCutoff],
		},
		{
			name: "activity",
			table: "activity",
			whereSql: "created_at < ?",
			params: [activityCutoff],
		},
	];

	for (const category of categories) {
		try {
			counts[category.name] = await deleteExpiredInChunks(
				env.DB,
				category.table,
				category.whereSql,
				category.params
			);
		} catch (err) {
			failures.push(category.name);
			console.error("scheduled retention purge failed", {
				category: category.name,
				err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			});
		}
	}

	// PROJ-865/869: one summary line with counts, not per-category noise on the happy path.
	console.log("scheduled retention purge complete", { deleted: counts, failed: failures });
}

// PROJ-865 (post-review correction): @cloudflare/workers-oauth-provider 0.10.3's
// purgeExpiredData has no cross-invocation cursor AND no cross-CALL cursor either — every
// call re-lists KV from the start of the "grant:" prefix, and `done` is only true once
// BOTH the grant phase and the token phase complete inside that one call (verified against
// node_modules/@cloudflare/workers-oauth-provider's source). A workspace with more than
// `batchSize` live grants therefore never finishes the grant phase in a single call, so
// `done` is always false and the "token:" phase is never even reached — looping this call
// in-process (the previous version of this function) just re-lists the same unpurged
// grants from scratch every iteration, burning this invocation's shared subrequest budget
// (see WIKI_TRASH_SUBREQUEST_BUDGET below, which shares the same cron fire) for no
// additional progress. The correct mitigation at this layer is a single call per run with
// a modest batchSize; `done:false` on a busy install is expected steady-state, not an
// error. True cross-run resumability (finishing the token phase even when there are many
// live grants) needs a purge we own — a persisted `kv.list` cursor plus the library's
// revoke helper — which is out of scope here and tracked as a follow-up ticket. Swallows
// its own failure — a housekeeping pass is never a reason to fail the cron and skip the
// work after it.
const OAUTH_PURGE_BATCH_SIZE = 200;

export async function purgeExpiredOAuthData(env: Env): Promise<void> {
	try {
		const result = await oauthProvider.purgeExpiredData(env, {
			batchSize: OAUTH_PURGE_BATCH_SIZE,
		});
		// done:false here just means more than a batch's worth of live grants exist — expected
		// and fine, since the next scheduled run picks up the remaining purgeable rows.
		console.log("scheduled OAuth purge complete", {
			done: result.done,
			grantsPurged: result.grantsPurged,
			tokensPurged: result.tokensPurged,
		});
	} catch (err) {
		console.error("scheduled OAuth purge failed", {
			err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		});
	}
}

// PROJ-865: KV key holding the workspace ids still owed a trash-purge pass from a run
// that hit its subrequest budget before finishing all of them — the next invocation
// resumes from this list instead of re-running the "find expired trash" query (which
// would just rediscover the same still-unpurged workspaces, at the cost of the query
// itself, so this is an optimization more than a correctness requirement).
const WIKI_TRASH_PURGE_CURSOR_KV_KEY = "cron:wiki-trash-purge:cursor";
// Conservative budget, well under the Workers per-invocation subrequest ceiling (1,000)
// — this cron shares the invocation with the OAuth and retention purges above. Counted
// via wrapD1WithBudget/wrapR2WithBudget below, which count each real D1 statement
// execution and each R2 call (batched or not) as one subrequest, matching how Cloudflare
// bills them.
const WIKI_TRASH_SUBREQUEST_BUDGET = 100;
// Once fewer than this many are left in the budget, stop STARTING another purge call —
// purgeExpiredWikiPages isn't internally preemptible, so this is sized to cover one
// call at its default page limit (measured ~40 subrequests), keeping the run within
// WIKI_TRASH_SUBREQUEST_BUDGET.
const WIKI_TRASH_MIN_BUDGET_TO_START_WORKSPACE = 45;

function createSubrequestBudget(limit: number) {
	let used = 0;
	return {
		spend(n = 1): void {
			used += n;
		},
		remaining(): number {
			return limit - used;
		},
		used(): number {
			return used;
		},
	};
}
type SubrequestBudget = ReturnType<typeof createSubrequestBudget>;

// Counts one subrequest per real D1 round trip (`.all()`/`.first()`/`.raw()`/`.run()`,
// and `.batch()` as one regardless of how many statements it carries, matching how D1
// bills a batch). A Proxy rather than a wrapper object so every drizzle/raw-SQL call site
// in the wrapped services keeps working unmodified.
function wrapD1WithBudget(db: D1Database, budget: SubrequestBudget): D1Database {
	const READ_METHODS = new Set(["all", "first", "raw", "run"]);
	return new Proxy(db, {
		get(dbTarget, dbProp, dbReceiver) {
			if (dbProp === "prepare") {
				return (sql: string) => {
					const stmt = Reflect.get(dbTarget, "prepare", dbReceiver).call(dbTarget, sql);
					return new Proxy(stmt, {
						get(stmtTarget, stmtProp, stmtReceiver) {
							if (stmtProp === "bind") {
								return (...args: unknown[]) => {
									const bound = Reflect.get(stmtTarget, "bind", stmtReceiver).call(
										stmtTarget,
										...args
									);
									return new Proxy(bound, {
										get(boundTarget, boundProp, boundReceiver) {
											const orig = Reflect.get(boundTarget, boundProp, boundReceiver);
											if (typeof boundProp === "string" && READ_METHODS.has(boundProp)) {
												return async (...a: unknown[]) => {
													budget.spend(1);
													return await orig.apply(boundTarget, a);
												};
											}
											return typeof orig === "function" ? orig.bind(boundTarget) : orig;
										},
									});
								};
							}
							const orig = Reflect.get(stmtTarget, stmtProp, stmtReceiver);
							return typeof orig === "function" ? orig.bind(stmtTarget) : orig;
						},
					});
				};
			}
			if (dbProp === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					budget.spend(1);
					return await Reflect.get(dbTarget, "batch", dbReceiver).call(dbTarget, statements);
				};
			}
			const orig = Reflect.get(dbTarget, dbProp, dbReceiver);
			return typeof orig === "function" ? orig.bind(dbTarget) : orig;
		},
	});
}

// Counts one subrequest per method call — used for both R2 (delete/put/get) and KV
// (get/put/delete), which don't have D1's prepare/bind/execute split.
function wrapCallsWithBudget<T extends object>(target: T, budget: SubrequestBudget): T {
	return new Proxy(target, {
		get(t, prop, receiver) {
			const orig = Reflect.get(t, prop, receiver);
			if (typeof orig !== "function") return orig;
			return (...args: unknown[]) => {
				budget.spend(1);
				return orig.apply(t, args);
			};
		},
	});
}

async function loadWikiTrashPurgeCursor(kv: KVNamespace): Promise<string[] | null> {
	const raw = await kv.get(WIKI_TRASH_PURGE_CURSOR_KV_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { workspaceIds?: unknown };
		return Array.isArray(parsed.workspaceIds)
			? parsed.workspaceIds.filter((id): id is string => typeof id === "string")
			: null;
	} catch {
		return null;
	}
}

async function saveWikiTrashPurgeCursor(
	kv: KVNamespace,
	remainingWorkspaceIds: string[]
): Promise<void> {
	if (remainingWorkspaceIds.length === 0) {
		await kv.delete(WIKI_TRASH_PURGE_CURSOR_KV_KEY);
	} else {
		await kv.put(
			WIKI_TRASH_PURGE_CURSOR_KV_KEY,
			JSON.stringify({ workspaceIds: remainingWorkspaceIds })
		);
	}
}

// PROJ-865: single query for workspaces that actually have expired trash, instead of
// iterating every workspace and running a per-workspace SELECT that finds nothing for
// the (usually large) majority with none.
async function findWorkspacesWithExpiredTrash(db: D1Database): Promise<string[]> {
	const cutoff = Math.floor(Date.now() / 1000) - WIKI_TRASH_RETENTION_SECONDS;
	const { results } = await db
		.prepare(
			"SELECT DISTINCT workspace_id AS id FROM wiki_pages WHERE deleted_at IS NOT NULL AND deleted_at < ?"
		)
		.bind(cutoff)
		.all<{ id: string }>();
	return (results ?? []).map((r) => r.id);
}

// PROJ-865: bounded per invocation via a subrequest budget (see WIKI_TRASH_SUBREQUEST_
// BUDGET) and a KV-persisted cursor of remaining workspace ids — a run that can't get
// through every workspace with expired trash stops cleanly and picks up where it left
// off on the next scheduled fire, rather than either doing unbounded work or silently
// dropping the workspaces it didn't get to (the pre-PROJ-865 behavior: iterate every
// workspace unconditionally, `console.error` any failure, and never revisit skipped
// ones). Failures are counted, not logged per workspace, and surfaced in the one summary
// line at the end.
export async function purgeAllWorkspacesExpiredWikiPages(env: Env): Promise<void> {
	// PROJ-865: the budget covers this function's own KV cursor read and the "find
	// workspaces" query too, not just the per-workspace purge loop below — those are real
	// subrequests against the same invocation's ceiling.
	const budget = createSubrequestBudget(WIKI_TRASH_SUBREQUEST_BUDGET);
	const budgetedKv = wrapCallsWithBudget(env.KV, budget);
	const cursor = await loadWikiTrashPurgeCursor(budgetedKv);
	// Always merge a fresh "who has expired trash" read into the saved cursor (cursor order
	// first), so a workspace that keeps failing or draining can't stop new workspaces from
	// ever being picked up.
	const fresh = await findWorkspacesWithExpiredTrash(wrapD1WithBudget(env.DB, budget));
	const remaining = [...new Set([...(cursor ?? []), ...fresh])];
	let purged = 0;
	let failed = 0;

	// PROJ-865: round-robin while budget remains. A workspace that still has expired pages
	// after one bounded call (moreExpired) goes to the back of the queue, so one huge
	// workspace can't hold everyone else's trash hostage; it keeps draining on later turns
	// and later runs. A workspace that fails goes to the back too and isn't retried again
	// this invocation (it stays in the cursor for the next run).
	const failedThisRun = new Set<string>();
	while (remaining.length > 0 && budget.remaining() >= WIKI_TRASH_MIN_BUDGET_TO_START_WORKSPACE) {
		const id = remaining[0] as string;
		if (failedThisRun.has(id)) {
			if (remaining.every((r) => failedThisRun.has(r))) break;
			remaining.push(remaining.shift() as string);
			continue;
		}
		const usedBefore = budget.used();
		const serviceCtx: ServiceCtx = {
			db: wrapD1WithBudget(env.DB, budget),
			kv: env.KV,
			r2: wrapCallsWithBudget(env.R2, budget),
			workspaceId: id,
			userId: "cron",
			role: "owner",
		};
		try {
			const result = await purgeExpiredWikiPages(serviceCtx);
			purged++;
			if (result.moreExpired) remaining.push(remaining.shift() as string);
			else remaining.shift();
		} catch (err) {
			failed++;
			failedThisRun.add(id);
			console.error("scheduled wiki trash purge failed for one workspace", {
				workspaceId: id,
				err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			});
			remaining.push(remaining.shift() as string);
		}
		// Every purge call spends subrequests; if one somehow didn't, stop rather than spin.
		if (budget.used() === usedBefore) break;
	}

	await saveWikiTrashPurgeCursor(budgetedKv, remaining);

	// PROJ-865: one summary log line with counts, not per-workspace noise on the happy path.
	console.log("scheduled wiki trash purge complete", {
		purgedWorkspaces: purged,
		failedWorkspaces: failed,
		remainingWorkspaces: remaining.length,
		subrequestsUsed: budget.used(),
	});
}

// `satisfies ExportedHandler<Env>` is load-bearing, not decoration: without it the
// default export is an unconstrained object literal, so a handler whose signature
// drifts from the Workers contract (this file typed `scheduled`'s first parameter as
// ScheduledEvent — the service-worker type — for its whole life) still typechecks.
// PROJ-656/657: the OAuth provider wraps the app rather than replacing it as the
// entrypoint, and this dispatcher is the reason.
//
// Declaring `/mcp/` an `apiRoute` makes the provider answer 401 to any request there
// without a bearer token — which is every request from the Cloudflare Access cookie,
// the local dev bypass, and the PUBLIC_READ_ONLY viewer that powers the live demo.
// Routing into the provider only for the two OAuth endpoints and for bearers that have
// the provider's own `<userId>:<grantId>:<secret>` shape leaves every other credential
// on exactly the path it takes today.
const oauthProvider = createOAuthProvider(app as unknown as ExportedHandler<Env>);

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (isOAuthProviderPath(pathname)) {
			// The token endpoint is served by the provider and never reaches Hono, so the
			// /oauth/* limiter mounted above does not cover it. It is unauthenticated by
			// definition (public clients, no secret), so it gets its own IP-keyed bound.
			const limited = await tokenEndpointRateLimited(request, env);
			return limited ?? oauthProvider.fetch(request, env, ctx);
		}
		if (isOAuthAccessToken(request)) return oauthProvider.fetch(request, env, ctx);
		return app.fetch(request, env, ctx);
	},
	scheduled,
} satisfies ExportedHandler<Env>;

export { RateLimiter } from "./lib/rate-limiter-do";
export { WorkspaceHub } from "./realtime/workspace-hub";
