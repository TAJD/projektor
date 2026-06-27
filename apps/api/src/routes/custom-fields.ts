import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	createCustomFieldDef,
	deleteCustomFieldDef,
	listCustomFieldDefs,
	updateCustomFieldDef,
} from "../services/custom-fields";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.query("projectId");
	try {
		return c.json(await listCustomFieldDefs(ctx, projectId));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createCustomFieldDef(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateCustomFieldDef(ctx, c.req.param("id"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await deleteCustomFieldDef(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as customFieldsRouter };
