import type { HonoEnv } from "@projektor/types";
import { type Context, Hono } from "hono";
import { jsonBody } from "../http/body";
import { serviceErrToResponse } from "../http/error-adapter";
import { authMiddleware, isPublicViewer } from "../middleware/auth";
import { createUserToken, deleteUserToken, getUserWorkspaces } from "../services/user-tokens";

const router = new Hono<HonoEnv>();

function isSafeRedirectPath(url: string): boolean {
	return url.startsWith("/") && !url.startsWith("//");
}

router.get("/login", (c) => {
	const requested = c.req.query("redirect_url") ?? "/";
	const redirectUrl = isSafeRedirectPath(requested) ? requested : "/";
	return c.redirect(redirectUrl, 302);
});

router.get("/me", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string; email: string; name: string };
	const workspaces = await getUserWorkspaces({ db: c.env.DB, userId: user.id });
	return c.json({ user, workspaces });
});

// PROJ-903: personal access tokens are minted and revoked only from an interactive
// human session (Cloudflare Access JWT or the dev bypass). A bearer token or OAuth grant
// must not be able to mint a PAT: a PAT minted without workspaceId is valid in every
// workspace the user belongs to, so a token confined to workspace A could otherwise
// escape its confinement (and widen its scopes), and the new secret would land in an
// agent's context. The shared PUBLIC_READ_ONLY viewer is "human" but anonymous, so it
// is refused too. Chosen over "confine the minted token to the caller": there is no
// machine use case for minting PATs, and the narrower rule has less to get wrong.
const HUMAN_SESSION_REQUIRED =
	"Personal access tokens can only be created or revoked from a signed-in browser session, not with an API token or connected app.";

function requireInteractiveHuman(c: Context<HonoEnv>): Response | null {
	const user = c.get("user") as { email: string } | undefined;
	if (c.get("authKind") !== "human" || !user || isPublicViewer(user)) {
		return c.json({ error: HUMAN_SESSION_REQUIRED }, 403);
	}
	return null;
}

router.post("/tokens", authMiddleware, async (c) => {
	const denied = requireInteractiveHuman(c);
	if (denied) return denied;
	const user = c.get("user") as { id: string };
	try {
		const result = await createUserToken({ db: c.env.DB, userId: user.id }, await jsonBody(c));
		return c.json(result, 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/tokens/:id", authMiddleware, async (c) => {
	const denied = requireInteractiveHuman(c);
	if (denied) return denied;
	const user = c.get("user") as { id: string };
	const id = c.req.param("id") ?? "";
	const result = await deleteUserToken({ db: c.env.DB, userId: user.id }, id);
	return c.json(result);
});

export { router as authRouter };
