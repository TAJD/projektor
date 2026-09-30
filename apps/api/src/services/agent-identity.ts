import { drizzle, schema } from "@projektor/db";
import { and, desc, eq, gt, type SQL } from "drizzle-orm";
import { ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

// Mirrors ACTIVE_TTL in services/agents.ts (and SESSION_TTL_SECONDS in
// services/issue-leases.ts). Duplicated rather than imported: both of those files import
// this one, so importing back would cycle.
const LIVE_TTL_SECONDS = 120;

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
	opts: { includeStale?: boolean } = {}
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
			.select({ id: schema.agentSessions.id })
			.from(schema.agentSessions)
			.where(and(...base, ...extra))
			.orderBy(desc(schema.agentSessions.lastHeartbeatAt))
			.limit(2);

	const cutoff = Math.floor(Date.now() / 1000) - LIVE_TTL_SECONDS;
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
					: "several live sessions on this credential — pass agentId from register_agent",
			],
		},
	});
}
