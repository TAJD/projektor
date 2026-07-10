import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { listProjectActivity } from "../services/project-activity";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/:id/activity", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const since = c.req.query("since");
		const limit = c.req.query("limit");
		return c.json(
			await listProjectActivity(ctx, {
				projectId: c.req.param("id"),
				since: since ? Number(since) : undefined,
				limit: limit ? Number(limit) : undefined,
			})
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as projectActivityRouter };
