import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	createIssue,
	deleteIssue,
	getIssue,
	listIssues,
	searchIssues,
	updateIssue,
} from "../services/issues";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	const {
		status,
		statusId,
		statusIds,
		category,
		priority,
		priorities,
		project: projectId,
		assignee,
		parentId,
		noParent,
		typeId,
		sprintId,
		cfKey,
		cfOp,
		cfValue,
		cursor,
		limit,
	} = c.req.query();
	try {
		return c.json(
			await listIssues(ctx, {
				status,
				statusId,
				statusIds,
				category,
				priority,
				priorities,
				projectId,
				assignee,
				parentId,
				noParent,
				typeId,
				sprintId,
				cfKey,
				cfOp,
				cfValue,
				cursor,
				limit,
			})
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/search", async (c) => {
	const ctx = ctxFromHono(c);
	const { q, projectId, limit } = c.req.query();
	try {
		return c.json(
			await searchIssues(ctx, { query: q, projectId, limit: limit ? Number(limit) : undefined })
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	const param = c.req.param("id");
	// Accept KEY-NUMBER refs (e.g. PROJ-42) as well as UUIDs
	const input = /^[A-Z]+-\d+$/.test(param) ? { ref: param } : { id: param };
	try {
		return c.json(await getIssue(ctx, input));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createIssue(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// Note: PATCH now accepts `assigneeId` (camelCase) instead of `assignee_id`.
router.patch("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateIssue(ctx, c.req.param("id"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await deleteIssue(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as issuesRouter };
