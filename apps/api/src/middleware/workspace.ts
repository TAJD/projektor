import type { HonoEnv } from "@projektor/types";
import type { Context, Next } from "hono";

export async function workspaceMiddleware(c: Context<HonoEnv>, next: Next) {
	// Workspace resolved from subdomain or X-Workspace-Slug header
	const slug = c.req.header("X-Workspace-Slug") ?? c.req.header("host")?.split(".")[0];

	if (!slug) return c.json({ error: "Workspace not specified" }, 400);

	const workspace = await c.env.DB.prepare("SELECT id, name, slug FROM workspaces WHERE slug = ?")
		.bind(slug)
		.first<{ id: string; name: string; slug: string }>();

	if (!workspace) return c.json({ error: "Workspace not found" }, 404);

	// PROJ-16: when auth came from a workspace-scoped token, enforce confinement.
	// null = user-scoped token (allowed in any workspace the user is a member of).
	// undefined = CF Access / dev-bypass (no token — membership check below is the gate).
	const tokenWorkspaceId = c.get("tokenWorkspaceId");
	if (tokenWorkspaceId != null && workspace.id !== tokenWorkspaceId) {
		return c.json({ error: "Forbidden" }, 403);
	}

	// Verify membership
	const user = c.get("user") as { id: string };
	const member = await c.env.DB.prepare(
		"SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
	)
		.bind(workspace.id, user.id)
		.first<{ role: string }>();

	if (!member) return c.json({ error: "Forbidden" }, 403);

	c.set("workspace", workspace);
	c.set("role", member.role);

	return next();
}
