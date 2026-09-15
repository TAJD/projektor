import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	createShareToken,
	getSharedIssue,
	getSharedLogo,
	revokeShareToken,
} from "../services/share";
import { ctxFromHono } from "../services/types";

// Authenticated router — POST/DELETE /api/issues/:id/share
const authedRouter = new Hono<HonoEnv>();

authedRouter.post("/:id/share", async (c) => {
	const ctx = ctxFromHono(c);
	const issueId = c.req.param("id");
	try {
		const result = await createShareToken(ctx, issueId);
		return c.json(result, 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

authedRouter.delete("/:id/share", async (c) => {
	const ctx = ctxFromHono(c);
	const issueId = c.req.param("id");
	try {
		await revokeShareToken(ctx, issueId);
		return c.json({ ok: true });
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { authedRouter as shareIssuesRouter };

// Unauthenticated router — GET /api/share/:token
const publicRouter = new Hono<HonoEnv>();

publicRouter.get("/:token", async (c) => {
	const token = c.req.param("token");
	try {
		const issue = await getSharedIssue(c.env.DB, token);
		return c.json(issue);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

publicRouter.get("/:token/logo", async (c) => {
	const token = c.req.param("token");
	const obj = await getSharedLogo(c.env.DB, c.env.R2, token);
	if (!obj) return c.json({ error: "No logo set" }, 404);
	const body = await obj.arrayBuffer();
	return new Response(body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": "public, max-age=300",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

export { publicRouter as sharePublicRouter };
