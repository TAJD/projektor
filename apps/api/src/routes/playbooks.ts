import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { getPlaybook, listPlaybooks } from "../services/playbooks";

const router = new Hono<HonoEnv>();

router.get("/", (c) => c.json(listPlaybooks()));

router.get("/:name", (c) => {
	try {
		return c.json(getPlaybook(c.req.param("name")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as playbooksRouter };
