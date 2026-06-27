import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { endAgent, heartbeatAgent, listActiveAgents, registerAgent } from "../services/agents";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	const { issueId } = c.req.query();
	try {
		return c.json(await listActiveAgents(ctx, { issueId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await registerAgent(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:id/heartbeat", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await heartbeatAgent(ctx, { id: c.req.param("id") }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:id/end", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await endAgent(ctx, { id: c.req.param("id") }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as agentsRouter };
