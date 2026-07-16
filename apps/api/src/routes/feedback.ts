import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serviceErrToResponse } from "../http/error-adapter";
import { bumpRateCounter } from "../middleware/rate-limit";
import { ForbiddenError, NotFoundError, ValidationError } from "../services/errors";
import {
	hashFeedbackToken,
	listFeedback,
	submitFeedback,
	updateFeedbackStatus,
} from "../services/feedback";
import { ctxFromHono } from "../services/types";

const publicRouter = new Hono<HonoEnv>();

// PROJ-378: this router is mounted ahead of the global app.use("*", logger())
// in index.ts (see Step 6 below), so it needs its own logging or submit
// requests go unlogged entirely.
publicRouter.use("*", logger());

// Anonymous end-user feedback preflight. We cannot know the source (no token on a
// preflight), so reflect the requesting Origin; the POST response is what actually
// enforces the per-source allow-list.
publicRouter.options("/submit", (c) => {
	const origin = c.req.header("Origin");
	const headers: Record<string, string> = {
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Max-Age": "86400",
	};
	if (origin) headers["Access-Control-Allow-Origin"] = origin;
	return c.body(null, 204, headers);
});

publicRouter.post("/submit", async (c) => {
	const auth = c.req.header("Authorization");
	if (!auth?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
	const token = auth.slice(7);
	const origin = c.req.header("Origin") ?? null;

	// Dual-keyed rate limit (token hash + IP) — reject if either trips its bucket.
	// Dedicated PROJ-378 env vars, not RATE_LIMIT_API_MAX/RATE_LIMIT_AUTH_MAX: this
	// route runs outside the global rateLimitMiddleware chain (mounted before it),
	// and anonymous feedback traffic must not share a budget with authenticated callers.
	const windowSecs = parseInt(c.env.RATE_LIMIT_WINDOW_SECS ?? "60", 10);
	const tokenLimit = parseInt(c.env.RATE_LIMIT_FEEDBACK_MAX ?? "30", 10);
	const ipLimit = parseInt(c.env.RATE_LIMIT_FEEDBACK_IP_MAX ?? "100", 10);
	const ip = c.req.header("CF-Connecting-IP") ?? "127.0.0.1";
	const tokenHash = await hashFeedbackToken(token);
	const tokenCount = await bumpRateCounter(c.env.DB, `feedback:${tokenHash}`, windowSecs);
	const ipCount = await bumpRateCounter(c.env.DB, `feedback-ip:${ip}`, windowSecs);
	if (tokenCount > tokenLimit || ipCount > ipLimit) {
		return c.json({ error: "Too Many Requests" }, 429);
	}

	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		rawBody = {};
	}

	try {
		const { id, corsAllowOrigin } = await submitFeedback(c.env.DB, token, rawBody, origin);
		if (corsAllowOrigin) c.header("Access-Control-Allow-Origin", corsAllowOrigin);
		return c.json({ id }, 201);
	} catch (e) {
		// Endpoint-specific mapping: an unknown/revoked source is an invalid
		// credential (401), an inactive source is a paused resource (403), a bad
		// body is 400. (NotFound → 401 here, unlike every other endpoint.)
		if (e instanceof ValidationError) return c.json({ error: e.issues }, 400);
		if (e instanceof ForbiddenError) return c.json({ error: e.message }, 403);
		if (e instanceof NotFoundError) return c.json({ error: e.message }, 401);
		throw e;
	}
});

export { publicRouter as feedbackPublicRouter };

const authedRouter = new Hono<HonoEnv>();

authedRouter.get("/:id/feedback", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const status = c.req.query("status");
	const sourceId = c.req.query("sourceId");
	try {
		return c.json(await listFeedback(ctx, { projectId, status, sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

authedRouter.patch("/:id/feedback/:feedbackId", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const feedbackId = c.req.param("feedbackId");
	const raw = await c.req.json();
	try {
		return c.json(await updateFeedbackStatus(ctx, { projectId, feedbackId, ...raw }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { authedRouter as feedbackRouter };
