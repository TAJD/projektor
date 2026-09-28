import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { jsonBody } from "../http/body";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	endAgent,
	finishWork,
	heartbeatAgent,
	listActiveAgents,
	registerAgent,
	startWork,
} from "../services/agents";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

// PROJ-929: REST parity for the start_work/finish_work MCP tools.
router.post("/start-work", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await startWork(ctx, await jsonBody(c)), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/finish-work", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await finishWork(ctx, await jsonBody(c)));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	const { issueId, projectId, includeStale } = c.req.query();
	try {
		return c.json(await listActiveAgents(ctx, { issueId, projectId, includeStale }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await registerAgent(ctx, await jsonBody(c)), 201);
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
