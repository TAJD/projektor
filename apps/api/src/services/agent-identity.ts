import { drizzle, schema } from "@projektor/db";
import { and, eq, gt } from "drizzle-orm";
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
 * `includeStale`: heartbeat_agent must be able to resolve a session that has just gone
 * stale (that call is what revives it), so it matches any still-`active` session; the
 * claim path requires a live one, since a dead session can't hold a lease.
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
	const conditions = [
		eq(schema.agentSessions.workspaceId, ctx.workspaceId),
		eq(schema.agentSessions.credentialId, credentialId),
		eq(schema.agentSessions.status, "active"),
	];
	if (!opts.includeStale) {
		const cutoff = Math.floor(Date.now() / 1000) - LIVE_TTL_SECONDS;
		conditions.push(gt(schema.agentSessions.lastHeartbeatAt, cutoff));
	}

	// Two rows are enough to tell "exactly one" from "several".
	const rows = await orm
		.select({ id: schema.agentSessions.id })
		.from(schema.agentSessions)
		.where(and(...conditions))
		.limit(2);

	if (rows.length === 1) return rows[0].id;

	// Kept under ~80 chars: the MCP adapter truncates each field message at that length
	// when it folds the summary into the JSON-RPC `message`, and the hint is the tail.
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
