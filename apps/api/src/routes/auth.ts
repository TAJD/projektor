import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { authMiddleware } from "../middleware/auth";
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

router.post("/tokens", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	try {
		const result = await createUserToken({ db: c.env.DB, userId: user.id }, await c.req.json());
		return c.json(result, 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/tokens/:id", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	const id = c.req.param("id") ?? "";
	const result = await deleteUserToken({ db: c.env.DB, userId: user.id }, id);
	return c.json(result);
});

export { router as authRouter };
