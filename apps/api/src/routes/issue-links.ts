import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { createLink, deleteLink, listLinksForIssue } from "../services/issue-links";
import { resolveIssueIdParam } from "../services/issues";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

// GET /api/issues/:issueId/links — accepts a ref ("PROJ-42") as well as a UUID, so the
// browser can ask for these alongside the issue itself rather than after it (PROJ-438).
router.get("/:issueId/links", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const issueId = await resolveIssueIdParam(ctx, c.req.param("issueId"));
		return c.json(await listLinksForIssue(ctx, { issueId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// POST /api/issues/:issueId/links
router.post("/:issueId/links", async (c) => {
	const ctx = ctxFromHono(c);
	const body = await c.req.json();
	try {
		return c.json(await createLink(ctx, { sourceIssueId: c.req.param("issueId"), ...body }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// DELETE /api/issues/:issueId/links/:linkId
router.delete("/:issueId/links/:linkId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await deleteLink(ctx, { id: c.req.param("linkId") }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as issueLinksRouter };
