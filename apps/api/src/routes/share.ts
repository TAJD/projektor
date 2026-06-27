import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { createShareToken, getSharedIssue } from "../services/share";
import { ctxFromHono } from "../services/types";

// Authenticated router — POST /api/issues/:id/share
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

export { publicRouter as sharePublicRouter };
