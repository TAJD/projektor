import type { Env, HonoEnv } from "@projektor/types";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serviceErrToResponse } from "./http/error-adapter";
import { safeDecodeURIComponent } from "./lib/urls";
import { injectWikiMetadata, resolveWikiPageForSsr } from "./lib/wiki-ssr";
import { authMiddleware } from "./middleware/auth";
import { etagMiddleware } from "./middleware/etag";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { workspaceMiddleware } from "./middleware/workspace";
import { agentMessagesRouter } from "./routes/agent-messages";
import { agentsRouter } from "./routes/agents";
import { authRouter } from "./routes/auth";
import { codeHeatmapRouter } from "./routes/code-heatmap";
import { commentsRouter } from "./routes/comments";
import { customFieldsRouter } from "./routes/custom-fields";
import { feedbackPublicRouter, feedbackRouter } from "./routes/feedback";
import { feedbackSourcesRouter } from "./routes/feedback-sources";
import { fileClaimsRouter } from "./routes/file-claims";
import { filesRouter } from "./routes/files";
import { flowMetricsRouter } from "./routes/flow-metrics";
import { groupsRouter } from "./routes/groups";
import { issueLinksRouter } from "./routes/issue-links";
import { issuesRouter } from "./routes/issues";
import { mcpRouter } from "./routes/mcp";
import { playbooksRouter } from "./routes/playbooks";
import { projectActivityRouter } from "./routes/project-activity";
import { projectsRouter } from "./routes/projects";
import { shareIssuesRouter, sharePublicRouter } from "./routes/share";
import { sprintsRouter } from "./routes/sprints";
import { taskStatusesRouter } from "./routes/task-statuses";
import { taskTypesRouter } from "./routes/task-types";
import { wikiRouter } from "./routes/wiki";
import { workflowRouter } from "./routes/workflow";
import { workspacesRouter } from "./routes/workspaces";
import { seedDefaultCustomFields } from "./services/custom-fields";
import { listProjectsAcrossWorkspaces } from "./services/projects";
import { seedDefaultTaskStatuses } from "./services/task-statuses";
import { seedDefaultTaskTypes } from "./services/task-types";
import type { ServiceCtx } from "./services/types";
import { purgeExpiredWikiPages } from "./services/wiki";
import { createWorkspace, listWorkspaces } from "./services/workspaces";

const app = new Hono<HonoEnv>();

// PROJ-430: Hono's default handler answers an uncaught throw with a bare,
// unlogged 500, which is why diagnosing the overnight error burst needed
// temporary instrumentation (PROJ-427/#131). Log the failure with its request
// context and return the same JSON error shape every other endpoint uses.
app.onError((err, c) => {
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

// Rate-limit all API and MCP traffic ahead of auth and heavy handlers.
// Keyed by bearer-token fingerprint when present, else by CF-Connecting-IP.
// Limits are read from RATE_LIMIT_AUTH_MAX / RATE_LIMIT_API_MAX env vars.
app.use("/api/*", rateLimitMiddleware);
app.use("/mcp/*", rateLimitMiddleware);

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
		mcpAddCommand:
			`claude mcp add --transport http --header "Authorization: Bearer ${token}" ` +
			`--header "X-Workspace-Slug: ${ws?.slug}" projektor "${mcpUrl}"`,
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
		return c.json(await createWorkspace(c.env.DB, user.id, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// All remaining /api/* and /mcp/* routes need auth + workspace context
app.use("/api/workspaces/:slug", authMiddleware, workspaceMiddleware);
app.use("/api/workspaces/:slug/*", authMiddleware, workspaceMiddleware);
// Cross-workspace project list — auth only, no workspace context needed
app.get("/api/projects", authMiddleware, etagMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	try {
		return c.json(await listProjectsAcrossWorkspaces(user.id, c.env.DB));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});
// Project mutations and /:id routes need workspace context
app.use("/api/projects", authMiddleware, workspaceMiddleware);
app.use("/api/projects/*", authMiddleware, workspaceMiddleware);
app.use("/api/issues", authMiddleware, workspaceMiddleware);
app.use("/api/issues/*", authMiddleware, workspaceMiddleware);
app.use("/api/issue-links", authMiddleware, workspaceMiddleware);
app.use("/api/issue-links/*", authMiddleware, workspaceMiddleware);
app.use("/api/wiki", authMiddleware, workspaceMiddleware);
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
app.use("/api/files", allowFilesQueryWorkspaceFallback);
app.use("/api/files/*", allowFilesQueryWorkspaceFallback);
app.use("/api/files", authMiddleware, workspaceMiddleware);
app.use("/api/files/*", authMiddleware, workspaceMiddleware);
app.use("/api/task-types", authMiddleware, workspaceMiddleware);
app.use("/api/task-types/*", authMiddleware, workspaceMiddleware);
app.use("/api/task-statuses", authMiddleware, workspaceMiddleware);
app.use("/api/task-statuses/*", authMiddleware, workspaceMiddleware);
app.use("/api/custom-fields", authMiddleware, workspaceMiddleware);
app.use("/api/custom-fields/*", authMiddleware, workspaceMiddleware);
app.use("/api/sprints", authMiddleware, workspaceMiddleware);
app.use("/api/sprints/*", authMiddleware, workspaceMiddleware);
app.use("/api/agents", authMiddleware, workspaceMiddleware);
app.use("/api/agents/*", authMiddleware, workspaceMiddleware);
app.use("/api/file-claims", authMiddleware, workspaceMiddleware);
app.use("/api/file-claims/*", authMiddleware, workspaceMiddleware);
app.use("/api/agent-messages", authMiddleware, workspaceMiddleware);
app.use("/api/agent-messages/*", authMiddleware, workspaceMiddleware);
// No workspaceMiddleware: the workflow spec is global, not workspace-scoped.
app.use("/api/workflow", authMiddleware);
app.use("/api/workflow/*", authMiddleware);
app.use("/api/playbooks", authMiddleware);
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
app.use("/api/issues", etagMiddleware);
app.use("/api/issues/*", etagMiddleware);
app.use("/api/task-statuses", etagMiddleware);

app.route("/api/workspaces", workspacesRouter);
app.route("/api/workspaces", groupsRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/projects", flowMetricsRouter);
app.route("/api/projects", codeHeatmapRouter);
app.route("/api/projects", projectActivityRouter);
app.route("/api/projects", feedbackSourcesRouter);
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
	_event: ScheduledEvent,
	env: Env,
	ctx: ExecutionContext
): Promise<void> {
	ctx.waitUntil(purgeAllWorkspacesExpiredWikiPages(env));
}

export async function purgeAllWorkspacesExpiredWikiPages(env: Env): Promise<void> {
	const { results } = await env.DB.prepare("SELECT id FROM workspaces").all<{ id: string }>();
	for (const { id } of results ?? []) {
		const serviceCtx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: id,
			userId: "cron",
			role: "owner",
		};
		try {
			await purgeExpiredWikiPages(serviceCtx);
		} catch (err) {
			console.error("scheduled wiki trash purge failed", {
				workspaceId: id,
				err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			});
		}
	}
}

export default {
	fetch: app.fetch,
	scheduled,
};
