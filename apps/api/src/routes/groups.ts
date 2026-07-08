import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	addGroupMember,
	createGroup,
	deleteGroup,
	getGroup,
	listGroups,
	listMemberGroups,
	removeGroupGrant,
	removeGroupMember,
	setGroupGrant,
	updateGroup,
} from "../services/groups";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/:slug/groups", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listGroups(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:slug/groups", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createGroup(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// Per-member group membership for the members-admin screen. Registered before
// /:slug/groups/:groupId so "member-groups" isn't captured as a group id.
router.get("/:slug/member-groups", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listMemberGroups(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/groups/:groupId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await getGroup(ctx, c.req.param("groupId")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:slug/groups/:groupId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateGroup(ctx, c.req.param("groupId"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/groups/:groupId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await deleteGroup(ctx, c.req.param("groupId")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:slug/groups/:groupId/members", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await addGroupMember(ctx, c.req.param("groupId"), await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/groups/:groupId/members/:userId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await removeGroupMember(ctx, c.req.param("groupId"), c.req.param("userId")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.put("/:slug/groups/:groupId/grants", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await setGroupGrant(ctx, c.req.param("groupId"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/groups/:groupId/grants/:projectId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await removeGroupGrant(ctx, c.req.param("groupId"), c.req.param("projectId")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as groupsRouter };
