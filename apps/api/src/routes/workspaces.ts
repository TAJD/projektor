import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { oauthApi } from "../oauth/provider";
import { listConnectorGrants, revokeConnectorGrant } from "../services/oauth";
import { ctxFromHono } from "../services/types";
import {
	createToken,
	deleteWorkspace,
	getWorkspaceMcpInfo,
	getWorkspaceWithMembers,
	inviteMember,
	listTokens,
	removeMember,
	revokeToken,
	updateMemberRole,
	updateWorkspace,
} from "../services/workspaces";

const router = new Hono<HonoEnv>();

// GET / and POST / are handled inline in index.ts (no workspace context yet at that point)

router.get("/:slug", async (c) => {
	const ctx = ctxFromHono(c);
	const workspace = c.get("workspace") as { id: string; name: string; slug: string };
	try {
		return c.json(await getWorkspaceWithMembers(ctx, workspace));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:slug", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateWorkspace(ctx, await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:slug/members", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await inviteMember(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/members/:userId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await removeMember(ctx, c.req.param("userId")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:slug/members/:userId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateMemberRole(ctx, c.req.param("userId"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:slug/tokens", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createToken(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/tokens", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listTokens(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/tokens/:tokenId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await revokeToken(ctx, c.req.param("tokenId")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// PROJ-659. Deliberately not mirrored as MCP tools: withdrawing a credential is a
// sensitive operation, and one a connector should not be able to perform on itself.
router.get("/:slug/connectors", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listConnectorGrants(oauthApi(c.env), ctx.userId, ctx.workspaceId));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/connectors/:grantId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(
			await revokeConnectorGrant(
				oauthApi(c.env),
				ctx.userId,
				ctx.workspaceId,
				c.req.param("grantId")
			)
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(
			await deleteWorkspace(ctx, c.req.param("slug"), c.env.DEFAULT_WORKSPACE_SLUG ?? "projektor")
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/mcp-info", async (c) => {
	const ctx = ctxFromHono(c);
	const workspace = c.get("workspace") as { id: string; name: string; slug: string };
	const origin = new URL(c.req.url).origin;
	try {
		return c.json(await getWorkspaceMcpInfo(ctx, workspace, origin));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as workspacesRouter };
