import type { HonoEnv } from "@projektor/types";
import type { Context, Next } from "hono";

// PROJ-296: accept common truthy spellings so operators don't silently
// disable subdomain routing with e.g. "1", "yes", or a non-"true" TOML bool.
export function subdomainRoutingEnabled(v: string | undefined): boolean {
	return ["true", "1", "yes"].includes(v?.trim().toLowerCase() ?? "");
}

// PROJ-295: the leading label of a Host header, but only when it plausibly
// names a tenant subdomain (3+ labels, not localhost/an IP) rather than a
// bare apex or a CDN/proxy artifact.
function subdomainCandidate(host: string | undefined): string | undefined {
	if (!host) return undefined;
	const hostname = host.split(":")[0];
	if (hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return undefined;
	const labels = hostname.split(".");
	if (labels.length < 3) return undefined;
	return labels[0];
}

// PROJ-295: warn (but keep failing closed) when a would-be-valid subdomain is being
// ignored because the flag is off — this catches the silent per-tenant outage an
// upgrade could otherwise cause.
async function warnIfIgnoredSubdomain(
	c: Context<HonoEnv>,
	headerSlug: string | undefined,
	routingEnabled: boolean
): Promise<void> {
	if (headerSlug || routingEnabled) return;
	const candidateSlug = subdomainCandidate(c.req.header("host"));
	if (!candidateSlug) return;
	const resolvable = await c.env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
		.bind(candidateSlug)
		.first<{ id: string }>();
	if (resolvable) {
		console.warn(
			`workspace subdomain "${candidateSlug}" would resolve but WORKSPACE_SUBDOMAIN_ROUTING is off; rejecting request`
		);
	}
}

export async function workspaceMiddleware(c: Context<HonoEnv>, next: Next) {
	// Workspace resolved from the X-Workspace-Slug header, or (opt-in) the Host header's
	// subdomain. See WORKSPACE_SUBDOMAIN_ROUTING in packages/types/src/env.ts. (PROJ-267)
	const headerSlug = c.req.header("X-Workspace-Slug");
	const routingEnabled = subdomainRoutingEnabled(c.env.WORKSPACE_SUBDOMAIN_ROUTING);
	const slug = headerSlug ?? (routingEnabled ? c.req.header("host")?.split(".")[0] : undefined);

	if (!slug) {
		await warnIfIgnoredSubdomain(c, headerSlug, routingEnabled);
		return c.json(
			{
				error: routingEnabled
					? "Workspace not specified"
					: "Workspace not specified: missing X-Workspace-Slug header",
			},
			400
		);
	}

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
