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

// PROJ-348: the MCP endpoint (POST /mcp/<workspaceId>) carries the workspace UUID
// in its path, so it can resolve the workspace without an X-Workspace-Slug header.
// The Claude app's Connectors UI restricts custom request headers to a fixed
// allowlist that excludes X-Workspace-Slug, so header-only resolution blocks it.
function mcpWorkspaceIdFromPath(path: string): string | undefined {
	return /^\/mcp\/([^/]+)$/.exec(path)?.[1];
}

export async function workspaceMiddleware(c: Context<HonoEnv>, next: Next) {
	// Workspace resolved from the X-Workspace-Slug header, or (opt-in) the Host header's
	// subdomain. See WORKSPACE_SUBDOMAIN_ROUTING in packages/types/src/env.ts. (PROJ-267)
	const headerSlug = c.req.header("X-Workspace-Slug");
	const routingEnabled = subdomainRoutingEnabled(c.env.WORKSPACE_SUBDOMAIN_ROUTING);
	const slug = headerSlug ?? (routingEnabled ? c.req.header("host")?.split(".")[0] : undefined);

	// PROJ-348: fall back to the MCP path's workspace UUID when no slug was resolved.
	// The token-workspace-scope check below is unchanged and remains the security
	// boundary — a token minted for another workspace is still rejected here.
	const mcpWorkspaceId = slug ? undefined : mcpWorkspaceIdFromPath(c.req.path);

	if (!slug && !mcpWorkspaceId) {
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

	// PROJ-432: the workspace and this user's membership of it in one round trip. They were
	// two sequential D1 queries, on a path every authenticated request goes through. A LEFT
	// JOIN keeps the two outcomes distinguishable: no row at all is a missing workspace
	// (404), a row with a null role is a non-member (403).
	const user = c.get("user") as { id: string };
	const lookup = `SELECT w.id, w.name, w.slug, m.role
	                FROM workspaces w
	                LEFT JOIN workspace_members m
	                  ON m.workspace_id = w.id AND m.user_id = ?
	                WHERE w.${mcpWorkspaceId ? "id" : "slug"} = ?`;
	const row = await c.env.DB.prepare(lookup)
		.bind(user.id, mcpWorkspaceId ?? slug)
		.first<{ id: string; name: string; slug: string; role: string | null }>();

	if (!row) return c.json({ error: "Workspace not found" }, 404);

	// PROJ-16: when auth came from a workspace-scoped token, enforce confinement.
	// null = user-scoped token (allowed in any workspace the user is a member of).
	// undefined = CF Access / dev-bypass (no token — the membership check below is the gate).
	// Checked before membership so a token pointed at the wrong workspace gets the same 403
	// it always did, rather than leaking whether the caller happens to be a member there.
	const tokenWorkspaceId = c.get("tokenWorkspaceId");
	if (tokenWorkspaceId != null && row.id !== tokenWorkspaceId) {
		return c.json({ error: "Forbidden" }, 403);
	}

	if (!row.role) return c.json({ error: "Forbidden" }, 403);

	c.set("workspace", { id: row.id, name: row.name, slug: row.slug });
	c.set("role", row.role);

	return next();
}
