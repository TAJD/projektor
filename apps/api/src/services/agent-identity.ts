import { drizzle, schema } from "@projektor/db";
import { and, desc, eq, gt, or, type SQL } from "drizzle-orm";
import { ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

export const SESSION_TTL_SECONDS = 120;

export function touchableSession(ctx: ServiceCtx, cutoff: number): SQL {
	const live = gt(schema.agentSessions.lastHeartbeatAt, cutoff);
	const credentialId = ctx.auth?.credentialId;
	return and(
		eq(schema.agentSessions.status, "active"),
		credentialId ? or(live, eq(schema.agentSessions.credentialId, credentialId)) : live
	) as SQL;
}

export function canReviveSession(
	ctx: ServiceCtx,
	session: { status: string; credential_id: string | null }
): boolean {
	return (
		session.status === "active" &&
		session.credential_id !== null &&
		session.credential_id === ctx.auth?.credentialId
	);
}

const MAX_NAMED_SESSIONS = 5;

function describeSessions(rows: readonly { id: string; name: string }[]): string {
	const shown = rows.slice(0, MAX_NAMED_SESSIONS).map((r) => `${r.name} (${r.id})`);
	return (rows.length > MAX_NAMED_SESSIONS ? [...shown, "…"] : shown).join(", ");
}

/**
 * PROJ-894: resolve the agent session a call acts as.
 *
 * An explicit `agentId` always wins. Without one, the credential the call authenticated
 * with (ctx.auth.credentialId, recorded on the session by register_agent) is looked up:
 * exactly one matching session means "that one". Zero or several is a validation error
 * telling the caller to pass agentId. Nothing is held per connection — the answer is
 * derived from the session table on every call, so this stays stateless (PROJ-452).
 *
 * Fleets that share one `pk_` token will normally have several live sessions on it, so
 * for them this always errors and they keep passing agentId — by design.
 *
 * `includeStale`: heartbeat_agent/end_agent may fall back to a session that has just gone
 * stale (that call is what revives it), but only when the credential has no live session;
 * the claim path requires a live one, since a dead session can't hold a lease.
 */
export async function resolveAgentSessionId(
	ctx: ServiceCtx,
	provided: string | undefined,
	opts: { includeStale?: boolean; nameSessions?: boolean } = {}
): Promise<string> {
	if (provided) return provided;

	const credentialId = ctx.auth?.credentialId;
	if (!credentialId) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: {
				agentId: ["no session on this credential — pass agentId from register_agent"],
			},
		});
	}

	const orm = drizzle(ctx.db, { schema });
	const base = [
		eq(schema.agentSessions.workspaceId, ctx.workspaceId),
		eq(schema.agentSessions.credentialId, credentialId),
		eq(schema.agentSessions.status, "active"),
	];
	// Two rows are enough to tell "exactly one" from "several".
	const find = (extra: SQL[]) =>
		orm
			.select({ id: schema.agentSessions.id, name: schema.agentSessions.name })
			.from(schema.agentSessions)
			.where(and(...base, ...extra))
			.orderBy(desc(schema.agentSessions.lastHeartbeatAt))
			.limit(opts.nameSessions ? MAX_NAMED_SESSIONS + 1 : 2);

	const cutoff = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;
	let rows = await find([gt(schema.agentSessions.lastHeartbeatAt, cutoff)]);
	// heartbeat/end must be able to reach a session that has just gone stale (that call
	// revives it) — but only when no live session exists, so an abandoned session left
	// behind by a crash can't make a lone agent's id-less heartbeat ambiguous.
	if (rows.length === 0 && opts.includeStale) rows = await find([]);

	if (rows.length === 1) return rows[0].id;

	throw new ValidationError({
		formErrors: [],
		fieldErrors: {
			agentId: [
				rows.length === 0
					? "no live session on this credential — pass agentId from register_agent"
					: `several ${opts.includeStale ? "active" : "live"} sessions on this credential${opts.nameSessions ? `: ${describeSessions(rows)}` : ""} — pass agentId from register_agent`,
			],
		},
	});
}

/**
 * PROJ-1078: agents on a shared credential get the "several sessions" error above, which
 * names each session as `name (id)`, and retry with the name. Resolve a name among the
 * calling credential's active sessions, preferring live ones; a name matching none or
 * several is a validation error.
 */
export async function resolveAgentSessionByName(ctx: ServiceCtx, name: string): Promise<string> {
	const fail = (message: string): never => {
		throw new ValidationError({ formErrors: [], fieldErrors: { agentId: [message] } });
	};
	const credentialId = ctx.auth?.credentialId;
	if (!credentialId) {
		return fail(`"${name}" is not a session id — pass agentId from register_agent`);
	}

	const rows = await drizzle(ctx.db, { schema })
		.select({
			id: schema.agentSessions.id,
			name: schema.agentSessions.name,
			lastHeartbeatAt: schema.agentSessions.lastHeartbeatAt,
		})
		.from(schema.agentSessions)
		.where(
			and(
				eq(schema.agentSessions.workspaceId, ctx.workspaceId),
				eq(schema.agentSessions.credentialId, credentialId),
				eq(schema.agentSessions.status, "active"),
				eq(schema.agentSessions.name, name)
			)
		)
		.orderBy(desc(schema.agentSessions.lastHeartbeatAt))
		.limit(MAX_NAMED_SESSIONS + 1);

	const cutoff = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;
	const live = rows.filter((r) => r.lastHeartbeatAt > cutoff);
	const candidates = live.length > 0 ? live : rows;
	if (candidates.length === 1) return candidates[0].id;
	return fail(
		candidates.length === 0
			? `no active session named "${name}" on this credential — pass agentId from register_agent`
			: `several sessions named "${name}" on this credential: ${describeSessions(candidates)} — pass the session id`
	);
}
