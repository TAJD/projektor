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
function parseDomainMapValue(v: unknown): { slug: string; role: Role } | null {
	if (!v || typeof v !== "object") return null;
	const slug =
		typeof (v as { slug?: unknown }).slug === "string" ? (v as { slug: string }).slug.trim() : "";
	const roleRaw =
		typeof (v as { role?: unknown }).role === "string"
			? (v as { role: string }).role.trim().toLowerCase()
			: "member";
	const role = (VALID_ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as Role) : "member";
	if (!slug) return null;
	return { slug, role };
}

function parseDomainMapJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function parseDomainMap(raw?: string): Map<string, { slug: string; role: Role }> {
	const map = new Map<string, { slug: string; role: Role }>();
	if (!raw) return map;
	const obj = parseDomainMapJson(raw);
	if (!obj || typeof obj !== "object") return map;
	for (const [domain, v] of Object.entries(obj as Record<string, unknown>)) {
		const entry = parseDomainMapValue(v);
		const d = domain.trim().toLowerCase();
		if (entry && d) map.set(d, entry);
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

/**
 * Make `user` an `owner` of the given workspace, given their current role there
 * (null = not a member). Split from the read so callers that already know the role
 * — see provisionAdmin's join — don't pay a second query to rediscover it.
 */
async function grantOwner(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	userId: string,
	currentRole: string | null
): Promise<void> {
	if (currentRole === null) {
		await orm
			.insert(schema.workspaceMembers)
			.values({ workspaceId, userId, role: "owner", joinedAt: Math.floor(Date.now() / 1000) })
			.onConflictDoNothing();
		return;
	}
	if (currentRole !== "owner") {
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

	await grantOwner(orm, workspaceId, userId, member?.role ?? null);
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
	// PROJ-433: every workspace plus this admin's role in each, in one query. The previous
	// shape read the workspace list and then looped a per-workspace membership SELECT, so
	// the cost of an already-provisioned admin grew with the number of workspaces. Steady
	// state is now this single read and no writes.
	const rows = await orm
		.select({
			id: schema.workspaces.id,
			slug: schema.workspaces.slug,
			role: schema.workspaceMembers.role,
		})
		.from(schema.workspaces)
		.leftJoin(
			schema.workspaceMembers,
			and(
				eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
				eq(schema.workspaceMembers.userId, user.id)
			)
		)
		.all();

	// First-run bootstrap: createWorkspace inserts the caller as `owner` and seeds default
	// task types/statuses. Only reachable once per instance, so the extra read it costs
	// never lands on the warm path.
	if (!rows.some((r) => r.slug === slug)) {
		try {
			await createWorkspace(env.DB, user.id, { name, slug });
		} catch (e) {
			// Lost a race with another admin's concurrent login — they created it, so we are
			// not its owner and the join above never saw it. Ensure membership explicitly.
			if (!(e instanceof ConflictError)) throw e;
		}
		const created = await orm
			.select({ id: schema.workspaces.id })
			.from(schema.workspaces)
			.where(eq(schema.workspaces.slug, slug))
			.get();
		if (created) await ensureOwner(orm, created.id, user.id);
	}

	// Admins own every workspace, including migrated ones they didn't create.
	for (const w of rows) {
		if (w.role !== "owner") await grantOwner(orm, w.id, user.id, w.role);
	}
}

// PROJ-433: this is reached on every authenticated request, not on a login event —
// Cloudflare Access mints its cookie at the edge, so the Worker only ever sees an
// already-valid JWT and there is no login to hang the work off. Its inputs (ADMIN_EMAILS,
// AUTO_JOIN_ROLE, WORKSPACE_DOMAIN_MAP) are fixed until redeploy and the work is
// idempotent, so re-running it per request bought nothing but D1 latency. Remember that it
// ran instead: isolate-local, with KV behind it for cold isolates — the same two-layer
// shape middleware/auth.ts already uses for Access keys and users (PROJ-354).
const inMemoryProvisionedCache = new Map<string, number>();
const PROVISIONED_LOCAL_TTL_MS = 300 * 1000;
const PROVISIONED_KV_TTL_SECS = 300;

function provisionedKey(userId: string): string {
	return `provisioned:${userId}`;
}

async function alreadyProvisioned(env: Env, userId: string): Promise<boolean> {
	const localExpiry = inMemoryProvisionedCache.get(userId);
	if (localExpiry && localExpiry > Date.now()) return true;

	if (!(await env.KV.get(provisionedKey(userId)))) return false;
	inMemoryProvisionedCache.set(userId, Date.now() + PROVISIONED_LOCAL_TTL_MS);
	return true;
}

async function markProvisioned(env: Env, userId: string): Promise<void> {
	inMemoryProvisionedCache.set(userId, Date.now() + PROVISIONED_LOCAL_TTL_MS);
	await env.KV.put(provisionedKey(userId), "1", { expirationTtl: PROVISIONED_KV_TTL_SECS });
}

/**
 * Test-only: drop the isolate-local marker. Module state outlives an individual test, so
 * without this a test that provisions the same user twice would silently skip the second
 * run and assert against the first one's writes.
 */
export function resetProvisioningCacheForTests(): void {
	inMemoryProvisionedCache.clear();
}

/**
 * Test-only: forget a specific user in *both* layers, so the next call really re-provisions.
 * Clearing the isolate-local map alone isn't enough — the KV marker would still short-circuit.
 */
export async function forgetProvisionedForTests(env: Env, userId: string): Promise<void> {
	inMemoryProvisionedCache.delete(userId);
	await env.KV.delete(provisionedKey(userId));
}

/**
 * Idempotent, config-driven provisioning for a Cloudflare Access (browser) identity.
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
 *
 * Runs at most once per user per PROVISIONED_LOCAL_TTL_MS. An admin therefore picks up
 * ownership of a workspace someone *else* created within that window rather than on their
 * very next request; a workspace they create themselves makes them owner immediately, via
 * createWorkspace.
 */
export async function ensureUserProvisioned(
	env: Env,
	user: { id: string; email: string }
): Promise<void> {
	if (await alreadyProvisioned(env, user.id)) return;
	// Only remember runs that reached a settled outcome. Bailing because a workspace hasn't
	// been bootstrapped yet is transient — caching it would leave that user unprovisioned
	// for the whole TTL after an admin finally creates it.
	if (await runProvisioning(env, user)) await markProvisioned(env, user.id);
}

async function runProvisioning(env: Env, user: { id: string; email: string }): Promise<boolean> {
	const slug = env.DEFAULT_WORKSPACE_SLUG?.trim() || "projektor";
	const name = env.DEFAULT_WORKSPACE_NAME?.trim() || "Projektor";
	const isAdmin = parseEmailSet(env.ADMIN_EMAILS).has(user.email.toLowerCase());

	const orm = drizzle(env.DB, { schema });

	// Admins own everything — bootstrap the default workspace if needed, then own all workspaces.
	if (isAdmin) {
		await provisionAdmin(orm, env, user, slug, name);
		return true;
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
		if (!ws) return false; // mapped workspace doesn't exist yet — nothing to join
		await orm
			.insert(schema.workspaceMembers)
			.values({
				workspaceId: ws.id,
				userId: user.id,
				role: mapped.role,
				joinedAt: Math.floor(Date.now() / 1000),
			})
			.onConflictDoNothing();
		return true;
	}

	// Plain non-admin: auto-join the default workspace at AUTO_JOIN_ROLE, if it exists.
	const role = resolveAutoJoinRole(env.AUTO_JOIN_ROLE);
	if (!role) return true; // auto-join disabled — settled by config, nothing to retry

	const ws = await orm
		.select({ id: schema.workspaces.id })
		.from(schema.workspaces)
		.where(eq(schema.workspaces.slug, slug))
		.get();
	if (!ws) return false; // wait for an admin to bootstrap the default workspace

	await orm
		.insert(schema.workspaceMembers)
		.values({
			workspaceId: ws.id,
			userId: user.id,
			role,
			joinedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoNothing();
	return true;
}

/**
 * PROJ-373: idempotently join the shared anonymous "public viewer" user (see
 * middleware/auth.ts's PUBLIC_READ_ONLY path) to the default workspace as
 * `viewer`. Deliberately hardcoded to `viewer` — unlike AUTO_JOIN_ROLE, this
 * has no configurable role; anonymous access is read-only or it doesn't exist.
 * A no-op until an admin has bootstrapped the default workspace.
 *
 * Cached like ensureUserProvisioned above, and for the same reason: with PUBLIC_READ_ONLY
 * on this is the hot path for every anonymous request. There is exactly one public-viewer
 * identity, so the marker is shared by all of them.
 */
export async function provisionPublicViewer(env: Env, user: { id: string }): Promise<void> {
	if (await alreadyProvisioned(env, user.id)) return;

	const slug = env.DEFAULT_WORKSPACE_SLUG?.trim() || "projektor";
	const orm = drizzle(env.DB, { schema });

	const ws = await orm
		.select({ id: schema.workspaces.id })
		.from(schema.workspaces)
		.where(eq(schema.workspaces.slug, slug))
		.get();
	if (!ws) return;

	await orm
		.insert(schema.workspaceMembers)
		.values({
			workspaceId: ws.id,
			userId: user.id,
			role: "viewer",
			joinedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoNothing();
	await markProvisioned(env, user.id);
}
