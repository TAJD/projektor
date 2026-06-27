import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { createProject, deleteProject, getProject, updateProject } from "../services/projects";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await createProject(ctx, body), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await getProject(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await updateProject(ctx, c.req.param("id"), body));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await deleteProject(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as projectsRouter };
