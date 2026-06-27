import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serviceErrToResponse } from "./http/error-adapter";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { workspaceMiddleware } from "./middleware/workspace";
import { agentMessagesRouter } from "./routes/agent-messages";
import { agentsRouter } from "./routes/agents";
import { authRouter } from "./routes/auth";
import { commentsRouter } from "./routes/comments";
import { customFieldsRouter } from "./routes/custom-fields";
import { fileClaimsRouter } from "./routes/file-claims";
import { filesRouter } from "./routes/files";
import { issueLinksRouter } from "./routes/issue-links";
import { issuesRouter } from "./routes/issues";
import { mcpRouter } from "./routes/mcp";
import { projectsRouter } from "./routes/projects";
import { shareIssuesRouter, sharePublicRouter } from "./routes/share";
import { sprintsRouter } from "./routes/sprints";
import { taskStatusesRouter } from "./routes/task-statuses";
import { taskTypesRouter } from "./routes/task-types";
import { wikiRouter } from "./routes/wiki";
import { workspacesRouter } from "./routes/workspaces";
import { seedDefaultCustomFields } from "./services/custom-fields";
import { listAllProjects } from "./services/projects";
import { seedDefaultTaskStatuses } from "./services/task-statuses";
import { seedDefaultTaskTypes } from "./services/task-types";
import { createWorkspace, listUserWorkspaces } from "./services/workspaces";

const app = new Hono<HonoEnv>();

app.use("*", logger());
app.use(
	"*",
	cors({
		origin: "*",
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
	// biome-ignore lint/style/noNonNullAssertion: ws was just upserted above; SELECT immediately after guarantees it exists
	await seedDefaultTaskTypes(c.env.DB, ws!.id);
	// biome-ignore lint/style/noNonNullAssertion: ws was just upserted above; SELECT immediately after guarantees it exists
	await seedDefaultTaskStatuses(c.env.DB, ws!.id);
	// biome-ignore lint/style/noNonNullAssertion: ws was just upserted above; SELECT immediately after guarantees it exists
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
		mcpAddCommand: `claude mcp add --transport http --header "Authorization: Bearer ${token}" --header "X-Workspace-Slug: ${ws?.slug}" projektor "${mcpUrl}"`,
	});
});

// Public share route — MUST be before auth middleware
app.route("/api/share", sharePublicRouter);

// Public auth routes
app.route("/auth", authRouter);

// Workspace list + create — auth only, no workspace context
app.get("/api/workspaces", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	return c.json(await listUserWorkspaces(c.env.DB, user.id));
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
app.get("/api/projects", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	try {
		return c.json(await listAllProjects(user.id, c.env.DB));
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

app.route("/api/workspaces", workspacesRouter);
app.route("/api/projects", projectsRouter);
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

// SPA fallback — paths with no matching static asset fall through here.
// Only active in production where the ASSETS binding is present.
// Issue pretty-URL paths (/projects/KEY/issues/N/title-slug) get the issue-detail
// page so its IssueDetail island can resolve the issue from the URL path client-side.
// Everything else gets the homepage.
app.get("*", async (c) => {
	if (!c.env.ASSETS) return c.notFound();
	const { pathname } = new URL(c.req.url);
	const fallbackPath = /^\/projects\/[^/]+\/issues\/\d+\//.test(pathname)
		? "/issues/view/index.html"
		: /^\/share\//.test(pathname)
			? "/share/view/index.html"
			: "/index.html";
	return c.env.ASSETS.fetch(new Request(new URL(fallbackPath, c.req.url).toString()));
});

async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export default app;
