import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { composePlaybook } from "../services/playbook-compose";
import { getPlaybook, listPlaybooks } from "../services/playbooks";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/", (c) => c.json(listPlaybooks()));

router.post("/:name/compose", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(
			await composePlaybook(ctx, { name: c.req.param("name"), params: await c.req.json() })
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:name", (c) => {
	try {
		return c.json(getPlaybook(c.req.param("name")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as playbooksRouter };
