import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { claimIssue, listIssueLeases, releaseIssue } from "../services/issue-leases";
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
		excludeTypeIds,
		sprintId,
		cfKey,
		cfOp,
		cfValue,
		completedAfter,
		completedBefore,
		updatedAfter,
		updatedBefore,
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
				excludeTypeIds,
				sprintId,
				cfKey,
				cfOp,
				cfValue,
				completedAfter,
				completedBefore,
				updatedAfter,
				updatedBefore,
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

// Issue leasing for parallel agents (PROJ-184)
router.post("/:id/claim", async (c) => {
	const ctx = ctxFromHono(c);
	const body = (await c.req.json().catch(() => ({}))) as { agentId?: string };
	try {
		return c.json(
			await claimIssue(ctx, { issueId: c.req.param("id"), agentId: body.agentId }),
			201
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:id/release", async (c) => {
	const ctx = ctxFromHono(c);
	const body = (await c.req.json().catch(() => ({}))) as { agentId?: string };
	try {
		return c.json(await releaseIssue(ctx, { issueId: c.req.param("id"), agentId: body.agentId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:id/leases", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listIssueLeases(ctx, { issueId: c.req.param("id") }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as issuesRouter };
