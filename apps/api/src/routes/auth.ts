import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { z } from "zod";
import { ScopeSchema } from "../auth/scopes";
import { authMiddleware } from "../middleware/auth";

const router = new Hono<HonoEnv>();

const TokenSchema = z.object({
	name: z.string().min(1).max(100),
	// Optional: omit for a user-scoped token (works across all the user's workspaces)
	workspaceId: z.string().uuid().optional(),
	scopes: z.array(ScopeSchema).min(1),
	expiresAt: z.number().int().positive().optional(),
});

router.get("/login", (c) => {
	const redirectUrl = c.req.query("redirect_url") ?? "/";
	return c.redirect(
		`https://${c.env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/login?redirect_url=${encodeURIComponent(redirectUrl)}`,
		302
	);
});

router.get("/me", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string; email: string; name: string };

	const { results: workspaces } = await c.env.DB.prepare(
		`SELECT w.id, w.name, w.slug, wm.role
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = ?`
	)
		.bind(user.id)
		.all();

	return c.json({ user, workspaces });
});

router.post("/tokens", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	const raw = await c.req.json();
	const result = TokenSchema.safeParse(raw);
	if (!result.success) return c.json({ error: result.error.flatten() }, 400);

	const { name, workspaceId, scopes, expiresAt } = result.data;

	// PROJ-17: when minting a workspace-scoped token, the caller must be a member
	// of that workspace. Omitting workspaceId mints a user-scoped token (NULL in DB),
	// which is valid across all workspaces the user is a member of.
	if (workspaceId !== undefined) {
		const member = await c.env.DB.prepare(
			"SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
		)
			.bind(workspaceId, user.id)
			.first();
		if (!member) return c.json({ error: "Forbidden" }, 403);
	}

	const rawToken = crypto.randomUUID() + crypto.randomUUID();
	const hash = await hashToken(rawToken);

	await c.env.DB.prepare(
		`INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			crypto.randomUUID(),
			workspaceId ?? null,
			user.id,
			name,
			hash,
			JSON.stringify(scopes),
			expiresAt ?? null,
			Math.floor(Date.now() / 1000)
		)
		.run();

	return c.json({ token: rawToken }, 201);
});

router.delete("/tokens/:id", authMiddleware, async (c) => {
	const user = c.get("user") as { id: string };
	await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
		.bind(c.req.param("id"), user.id)
		.run();
	return c.json({ ok: true });
});

async function hashToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export { router as authRouter };
