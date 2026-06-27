import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	completeSprint,
	createSprint,
	deleteSprint,
	getSprint,
	listSprints,
	moveIssuesToSprint,
	updateSprint,
} from "../services/sprints";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	const { projectId } = c.req.query();
	try {
		return c.json(await listSprints(ctx, { projectId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createSprint(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await getSprint(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateSprint(ctx, c.req.param("id"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:id/complete", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await completeSprint(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await deleteSprint(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:id/move-issues", async (c) => {
	const ctx = ctxFromHono(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	try {
		return c.json(await moveIssuesToSprint(ctx, { ...body, sprintId: c.req.param("id") }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as sprintsRouter };
