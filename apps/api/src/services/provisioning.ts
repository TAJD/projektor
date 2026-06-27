import { drizzle, schema } from "@projektor/db";
import type { Env } from "@projektor/types";
import { and, eq } from "drizzle-orm";
import { ConflictError } from "./errors";
import { createWorkspace } from "./workspaces";

const VALID_ROLES = ["owner", "admin", "member", "viewer"] as const;
type Role = (typeof VALID_ROLES)[number];

function parseEmailSet(raw?: string): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean)
	);
}

function resolveAutoJoinRole(raw?: string): Role | null {
	// Safe default for public self-hosting (PROJ-193): invite-only. When AUTO_JOIN_ROLE
	// is unset we do NOT auto-join CF-Access-admitted users — an operator who wants
	// open auto-join must opt in explicitly (e.g. AUTO_JOIN_ROLE=viewer). This prevents
	// a fresh public instance from silently granting every admitted user read access to
	// the default workspace.
	const v = (raw ?? "none").trim().toLowerCase();
	if (v === "none") return null;
	return (VALID_ROLES as readonly string[]).includes(v) ? (v as Role) : "viewer";
}

/**
 * Parse WORKSPACE_DOMAIN_MAP — a JSON object mapping an email domain to the
 * workspace its (non-admin) users are confined to, e.g.
 *   {"example.com": {"slug": "example-team", "role": "member"}}
 * Invalid entries are skipped; a malformed value yields an empty map (so the
 * default-workspace behaviour applies, never a crash).
 */
function parseDomainMap(raw?: string): Map<string, { slug: string; role: Role }> {
	const map = new Map<string, { slug: string; role: Role }>();
	if (!raw) return map;
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return map;
	}
	if (!obj || typeof obj !== "object") return map;
	for (const [domain, v] of Object.entries(obj as Record<string, unknown>)) {
		if (!v || typeof v !== "object") continue;
		const slug =
			typeof (v as { slug?: unknown }).slug === "string" ? (v as { slug: string }).slug.trim() : "";
		const roleRaw =
			typeof (v as { role?: unknown }).role === "string"
				? (v as { role: string }).role.trim().toLowerCase()
				: "member";
		const role = (VALID_ROLES as readonly string[]).includes(roleRaw)
			? (roleRaw as Role)
			: "member";
		const d = domain.trim().toLowerCase();
		if (slug && d) map.set(d, { slug, role });
	}
	return map;
}

function resolveDomainMapping(
	raw: string | undefined,
	email: string
): { slug: string; role: Role } | null {
	const at = email.lastIndexOf("@");
	if (at < 0) return null;
	return parseDomainMap(raw).get(email.slice(at + 1).toLowerCase()) ?? null;
}

/** Ensure `user` is an `owner` member of the given workspace (insert or promote). */
async function ensureOwner(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	userId: string
): Promise<void> {
	const member = await orm
		.select({ role: schema.workspaceMembers.role })
		.from(schema.workspaceMembers)
		.where(
			and(
				eq(schema.workspaceMembers.workspaceId, workspaceId),
				eq(schema.workspaceMembers.userId, userId)
			)
		)
		.get();

	if (!member) {
		await orm
			.insert(schema.workspaceMembers)
			.values({ workspaceId, userId, role: "owner", joinedAt: Math.floor(Date.now() / 1000) })
			.onConflictDoNothing();
		return;
	}
	if (member.role !== "owner") {
		await orm
			.update(schema.workspaceMembers)
			.set({ role: "owner" })
			.where(
				and(
					eq(schema.workspaceMembers.workspaceId, workspaceId),
					eq(schema.workspaceMembers.userId, userId)
				)
			);
	}
}

/**
 * Provision an admin: they own EVERY workspace on this instance. The first admin to log in
 * also bootstraps the default workspace if it doesn't exist yet (first-run).
 */
async function provisionAdmin(
	orm: ReturnType<typeof drizzle>,
	env: Env,
	user: { id: string; email: string },
	slug: string,
	name: string
): Promise<void> {
	// Ensure the default workspace exists (first-run bootstrap). createWorkspace inserts the
	// caller as `owner` and seeds default task types/statuses.
	const def = await orm
		.select({ id: schema.workspaces.id })
		.from(schema.workspaces)
		.where(eq(schema.workspaces.slug, slug))
		.get();
	if (!def) {
		try {
			await createWorkspace(env.DB, user.id, { name, slug });
		} catch (e) {
			// Lost a race with another admin's concurrent login — the loop below still ensures membership.
			if (!(e instanceof ConflictError)) throw e;
		}
	}

	// Make this admin an owner of every workspace (including any migrated ones they didn't create).
	const all = await orm.select({ id: schema.workspaces.id }).from(schema.workspaces).all();
	for (const w of all) {
		await ensureOwner(orm, w.id, user.id);
	}
}

/**
 * Idempotent, config-driven provisioning run on every Cloudflare Access (browser) login.
 *
 * Cloudflare Access (backed by the Entra email list) is the gate — it decides *who* may log
 * in. This decides *what they get* once inside:
 *   - email ∈ ADMIN_EMAILS  → `owner` of EVERY workspace. The FIRST admin to log in also
 *                             creates the default workspace if it doesn't exist yet (first-run).
 *   - domain-mapped non-admin → confined to the single mapped workspace (never the default).
 *   - otherwise             → AUTO_JOIN_ROLE (default `viewer`) in the default workspace;
 *                             `none` disables auto-join.
 *
 * Non-admins who log in before any workspace exists simply get no membership yet (they will
 * 403 on workspace routes) until an admin has bootstrapped the default workspace.
 *
 * API-token / MCP auth never reaches here — those identities are provisioned explicitly when
 * the token is minted, so we leave them untouched.
 */
export async function provisionUserOnLogin(
	env: Env,
	user: { id: string; email: string }
): Promise<void> {
	const slug = env.DEFAULT_WORKSPACE_SLUG?.trim() || "projektor";
	const name = env.DEFAULT_WORKSPACE_NAME?.trim() || "Projektor";
	const isAdmin = parseEmailSet(env.ADMIN_EMAILS).has(user.email.toLowerCase());

	const orm = drizzle(env.DB, { schema });

	// Admins own everything — bootstrap the default workspace if needed, then own all workspaces.
	if (isAdmin) {
		await provisionAdmin(orm, env, user, slug, name);
		return;
	}

	// Domain confinement: a non-admin whose email domain is mapped joins ONLY the mapped
	// workspace (never the default), so membership-scoped reads naturally confine them to it.
	const mapped = resolveDomainMapping(env.WORKSPACE_DOMAIN_MAP, user.email);
	if (mapped) {
		const ws = await orm
			.select({ id: schema.workspaces.id })
			.from(schema.workspaces)
			.where(eq(schema.workspaces.slug, mapped.slug))
			.get();
		if (!ws) return; // mapped workspace doesn't exist yet — nothing to join
		await orm
			.insert(schema.workspaceMembers)
			.values({
				workspaceId: ws.id,
				userId: user.id,
				role: mapped.role,
				joinedAt: Math.floor(Date.now() / 1000),
			})
			.onConflictDoNothing();
		return;
	}

	// Plain non-admin: auto-join the default workspace at AUTO_JOIN_ROLE, if it exists.
	const role = resolveAutoJoinRole(env.AUTO_JOIN_ROLE);
	if (!role) return; // auto-join disabled

	const ws = await orm
		.select({ id: schema.workspaces.id })
		.from(schema.workspaces)
		.where(eq(schema.workspaces.slug, slug))
		.get();
	if (!ws) return; // wait for an admin to bootstrap the default workspace

	await orm
		.insert(schema.workspaceMembers)
		.values({
			workspaceId: ws.id,
			userId: user.id,
			role,
			joinedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoNothing();
}
