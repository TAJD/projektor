import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	createProject,
	deleteProject,
	getProject,
	getProjectBySlug,
	updateProject,
} from "../services/projects";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
	const param = c.req.param("id");
	try {
		// PROJ-376: pretty project URLs pass a slug (e.g. "start-line") here instead
		// of a UUID.
		return c.json(
			UUID_RE.test(param) ? await getProject(ctx, param) : await getProjectBySlug(ctx, param)
		);
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
