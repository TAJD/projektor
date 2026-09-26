import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { jsonBody } from "../http/body";
import { serviceErrToResponse } from "../http/error-adapter";
import { isPublicViewer, requireInteractiveHuman } from "../middleware/auth";
import { oauthApi } from "../oauth/provider";
import { listConnectorGrants, revokeConnectorGrant } from "../services/oauth";
import { ctxFromHono } from "../services/types";
import {
	createToken,
	deleteWorkspace,
	deleteWorkspaceLogo,
	getWorkspaceBrand,
	getWorkspaceLogoObject,
	getWorkspaceMcpInfo,
	getWorkspaceWithMembers,
	inviteMember,
	listTokens,
	removeMember,
	revokeToken,
	updateMemberRole,
	updateWorkspace,
	updateWorkspaceBrand,
	uploadWorkspaceLogo,
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
		return c.json(await updateWorkspace(ctx, await jsonBody(c)));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:slug/members", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await inviteMember(ctx, await jsonBody(c)), 201);
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
		return c.json(await updateMemberRole(ctx, c.req.param("userId"), await jsonBody(c)));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// PROJ-917: workspace tokens follow the same rule as personal access tokens
// (PROJ-903, routes/auth.ts) — minted and revoked only from an interactive human
// session. Otherwise an agent's pk_ token or OAuth grant could mint a sibling token
// with wider scopes than its own, and the new secret would land in an agent's
// context. Chosen over "new scopes must be a subset of the caller's": there is no
// machine use case for minting workspace tokens. Listing stays open to admins on any
// credential — it returns no secrets.
const WORKSPACE_TOKEN_HUMAN_ONLY =
	"Workspace tokens can only be created or revoked from a signed-in browser session, not with an API token or connected app.";

router.post("/:slug/tokens", async (c) => {
	const denied = requireInteractiveHuman(c, WORKSPACE_TOKEN_HUMAN_ONLY);
	if (denied) return denied;
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createToken(ctx, await jsonBody(c)), 201);
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
	const denied = requireInteractiveHuman(c, WORKSPACE_TOKEN_HUMAN_ONLY);
	if (denied) return denied;
	const ctx = ctxFromHono(c);
	try {
		return c.json(await revokeToken(ctx, c.req.param("tokenId")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// PROJ-659. Deliberately not mirrored as MCP tools: withdrawing a credential is a
// sensitive operation, and one a connector should not be able to perform on itself.
//
// The shared PUBLIC_READ_ONLY viewer is one identity for every anonymous visitor on the
// internet and a real `viewer` member of the default workspace, so "your own grants"
// would mean "everyone's grants" for it. It cannot consent to a grant in the first place
// (routes/oauth.ts), which makes the list provably empty today — but that is an
// invariant enforced two files away, and this endpoint should not depend on it.
function connectorsDenied(c: Parameters<typeof ctxFromHono>[0]): Response | null {
	const user = c.get("user") as { email: string } | undefined;
	if (!user || isPublicViewer(user)) {
		return c.json({ error: "Connectors are personal credentials and need a signed-in user" }, 403);
	}
	return null;
}

router.get("/:slug/connectors", async (c) => {
	const denied = connectorsDenied(c);
	if (denied) return denied;
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listConnectorGrants(oauthApi(c.env), ctx.userId, ctx.workspaceId));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/connectors/:grantId", async (c) => {
	const denied = connectorsDenied(c);
	if (denied) return denied;
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

router.get("/:slug/brand", async (c) => {
	const ctx = ctxFromHono(c);
	const workspace = c.get("workspace") as { slug: string };
	try {
		return c.json(await getWorkspaceBrand(ctx, workspace.slug));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:slug/brand", async (c) => {
	const ctx = ctxFromHono(c);
	const workspace = c.get("workspace") as { slug: string };
	try {
		return c.json(await updateWorkspaceBrand(ctx, workspace.slug, await jsonBody(c)));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:slug/brand/logo", async (c) => {
	const ctx = ctxFromHono(c);
	const formData = await c.req.formData().catch(() => null);
	if (!formData) return c.json({ error: "Expected multipart/form-data" }, 400);
	const fileRaw = formData.get("file");
	if (!fileRaw || typeof fileRaw === "string") return c.json({ error: "Missing file field" }, 400);
	try {
		return c.json(await uploadWorkspaceLogo(ctx, fileRaw as File), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/brand/logo", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		await deleteWorkspaceLogo(ctx);
		return new Response(null, { status: 204 });
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/brand/logo", async (c) => {
	const ctx = ctxFromHono(c);
	let obj: Awaited<ReturnType<typeof getWorkspaceLogoObject>>;
	try {
		obj = await getWorkspaceLogoObject(ctx);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
	if (!obj) return c.json({ error: "No logo set" }, 404);
	const body = await obj.arrayBuffer();
	return new Response(body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": "public, max-age=300",
			"X-Content-Type-Options": "nosniff",
		},
	});
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
