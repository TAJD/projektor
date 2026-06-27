import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { addComment, deleteComment, listComments, updateComment } from "../services/comments";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/:issueId/comments", async (c) => {
	const ctx = ctxFromHono(c);
	const issueId = c.req.param("issueId");
	try {
		return c.json(await listComments(ctx, { issueId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:issueId/comments", async (c) => {
	const ctx = ctxFromHono(c);
	const issueId = c.req.param("issueId");
	const raw = await c.req.json();
	try {
		return c.json(await addComment(ctx, { issueId, ...raw }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:issueId/comments/:id", async (c) => {
	const ctx = ctxFromHono(c);
	const issueId = c.req.param("issueId");
	const commentId = c.req.param("id");
	const raw = await c.req.json();
	try {
		return c.json(await updateComment(ctx, { issueId, commentId, ...raw }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:issueId/comments/:id", async (c) => {
	const ctx = ctxFromHono(c);
	const issueId = c.req.param("issueId");
	const commentId = c.req.param("id");
	try {
		return c.json(await deleteComment(ctx, { issueId, commentId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as commentsRouter };
