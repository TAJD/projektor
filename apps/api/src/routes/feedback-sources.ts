import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	createFeedbackSource,
	getFeedbackSource,
	listFeedbackSources,
	revokeFeedbackSource,
	rotateFeedbackSourceToken,
	updateFeedbackSource,
} from "../services/feedback-sources";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.post("/:id/feedback-sources", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const raw = await c.req.json();
	try {
		return c.json(await createFeedbackSource(ctx, { ...raw, projectId }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:id/feedback-sources", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	try {
		return c.json(await listFeedbackSources(ctx, { projectId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:id/feedback-sources/:sourceId", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const sourceId = c.req.param("sourceId");
	const raw = await c.req.json();
	try {
		return c.json(await updateFeedbackSource(ctx, { ...raw, projectId, sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:id/feedback-sources/:sourceId/rotate", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const sourceId = c.req.param("sourceId");
	try {
		return c.json(await rotateFeedbackSourceToken(ctx, { projectId, sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:id/feedback-sources/:sourceId", async (c) => {
	const ctx = ctxFromHono(c);
	const projectId = c.req.param("id");
	const sourceId = c.req.param("sourceId");
	try {
		return c.json(await revokeFeedbackSource(ctx, { projectId, sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

const lookupRouter = new Hono<HonoEnv>();

lookupRouter.get("/:sourceId", async (c) => {
	const ctx = ctxFromHono(c);
	const sourceId = c.req.param("sourceId");
	try {
		return c.json(await getFeedbackSource(ctx, { sourceId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { lookupRouter as feedbackSourceLookupRouter, router as feedbackSourcesRouter };
