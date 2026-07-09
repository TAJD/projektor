import { drizzle, schema } from "@projektor/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
	ClaimIssueSchema,
	ListIssueLeasesSchema,
	ReleaseIssueSchema,
} from "../schemas/issue-leases";
import { visibleProjectPredicate } from "./access";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

// Mirrors ACTIVE_TTL in services/agents.ts: a session (and therefore its leases)
// is live only while it has heartbeat within this window. Kept local to avoid a
// circular import (agents.ts already imports releaseLeasesForAgent from here).
const SESSION_TTL_SECONDS = 120;

const liveCutoff = () => Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;

// PROJ-253: per-project agent WIP cap, used when a project doesn't set its own
// projects.agent_wip_limit.
const DEFAULT_AGENT_WIP_LIMIT = 3;

async function assertIssueExists(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	issueId: string
): Promise<{ projectId: string }> {
	const issue = await orm
		.select({ id: schema.issues.id, projectId: schema.issues.projectId })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (!issue) throw new NotFoundError("Issue not found");
	return { projectId: issue.projectId };
}

// The project's agent WIP cap (its own agent_wip_limit, else the default).
async function fetchAgentWipCap(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	projectId: string
): Promise<number> {
	const project = await orm
		.select({ agentWipLimit: schema.projects.agentWipLimit })
		.from(schema.projects)
		.where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	return project?.agentWipLimit ?? DEFAULT_AGENT_WIP_LIMIT;
}

// The issue ids currently held by a live lease in this project — only used to build
// a helpful error when a claim is rejected for hitting the cap.
async function liveLeaseHoldersForProject(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	projectId: string,
	cutoff: number
): Promise<string[]> {
	const live = await orm
		.select({ issueId: schema.issueLeases.issueId })
		.from(schema.issueLeases)
		.innerJoin(schema.issues, eq(schema.issueLeases.issueId, schema.issues.id))
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				isNull(schema.issueLeases.releasedAt),
				eq(schema.issues.projectId, projectId),
				eq(schema.agentSessions.status, "active"),
				gt(schema.agentSessions.lastHeartbeatAt, cutoff)
			)
		);
	return live.map((l) => l.issueId);
}

// The claiming session must itself be live — a dead agent can't hold a lease.
async function assertAgentSessionLive(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	agentId: string,
	cutoff: number
): Promise<void> {
	const session = await orm
		.select({
			status: schema.agentSessions.status,
			heartbeat: schema.agentSessions.lastHeartbeatAt,
		})
		.from(schema.agentSessions)
		.where(
			and(
				eq(schema.agentSessions.id, agentId),
				eq(schema.agentSessions.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!session) throw new NotFoundError("Agent session not found");
	if (session.status !== "active" || session.heartbeat <= cutoff) {
		throw new ValidationError({
			formErrors: ["Agent session is not live — heartbeat before claiming"],
			fieldErrors: {},
		});
	}
}

// Is there already an active lease on this issue? Join the session to decide
// whether it's a live conflict or a stale lease we can reclaim.
async function reclaimStaleLeaseOrThrow(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	issueId: string,
	cutoff: number,
	now: number
): Promise<void> {
	const existing = await orm
		.select({
			id: schema.issueLeases.id,
			agentSessionId: schema.issueLeases.agentSessionId,
			sessionStatus: schema.agentSessions.status,
			sessionHeartbeat: schema.agentSessions.lastHeartbeatAt,
		})
		.from(schema.issueLeases)
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				eq(schema.issueLeases.issueId, issueId),
				isNull(schema.issueLeases.releasedAt)
			)
		)
		.get();
	if (!existing) return;

	const live = existing.sessionStatus === "active" && existing.sessionHeartbeat > cutoff;
	if (live) {
		throw new ConflictError(`Issue is already leased by agent session ${existing.agentSessionId}`);
	}
	// Stale lease: the holder stopped heartbeating. Reclaim it.
	await orm
		.update(schema.issueLeases)
		.set({ releasedAt: now, releaseReason: "expired" })
		.where(eq(schema.issueLeases.id, existing.id));
}

/**
 * Claim an issue for an agent session. Two independent atomicity guards, both
 * enforced inside a single INSERT so concurrent claims can't race (PROJ-290 —
 * D1 has no interactive transactions, and a read-then-insert let two claims each
 * see cap-1 and both proceed):
 *   1. Per-issue: the partial UNIQUE index on (workspace_id, issue_id) WHERE
 *      released_at IS NULL — at most one active lease per issue.
 *   2. Per-project WIP cap: the INSERT ... SELECT ... WHERE (live-lease count) <
 *      cap subquery is evaluated as part of the write statement (SQLite holds the
 *      db write lock), so a concurrent claim sees the other's just-inserted row
 *      and the count can't be undercounted.
 * A lease whose owning session has gone stale is reclaimed transparently first.
 */
export async function claimIssue(ctx: ServiceCtx, raw: unknown) {
	const result = ClaimIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, agentId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const cutoff = liveCutoff();

	const { projectId } = await assertIssueExists(orm, ctx, issueId);
	await assertAgentSessionLive(orm, ctx, agentId, cutoff);
	const cap = await fetchAgentWipCap(orm, ctx, projectId);

	const now = Math.floor(Date.now() / 1000);
	await reclaimStaleLeaseOrThrow(orm, ctx, issueId, cutoff, now);

	const id = crypto.randomUUID();
	let res: D1Result;
	try {
		res = await ctx.db
			.prepare(
				`INSERT INTO issue_leases (id, workspace_id, issue_id, agent_session_id, claimed_at, released_at, release_reason)
				 SELECT ?, ?, ?, ?, ?, NULL, NULL
				 WHERE (
				   SELECT COUNT(*) FROM issue_leases il
				   JOIN issues i ON i.id = il.issue_id
				   JOIN agent_sessions s ON s.id = il.agent_session_id
				   WHERE il.workspace_id = ? AND il.released_at IS NULL
				     AND i.project_id = ? AND s.status = 'active' AND s.last_heartbeat_at > ?
				 ) < ?`
			)
			.bind(id, ctx.workspaceId, issueId, agentId, now, ctx.workspaceId, projectId, cutoff, cap)
			.run();
	} catch (e) {
		// Lost a genuine race: another claim inserted the active lease for THIS
		// issue first and the partial UNIQUE index rejected ours.
		if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
			throw new ConflictError("Issue was just leased by another agent");
		}
		throw e;
	}

	// No row inserted and no UNIQUE violation ⇒ the WIP-cap guard subquery held.
	if (res.meta.changes === 0) {
		const held = await liveLeaseHoldersForProject(orm, ctx, projectId, cutoff);
		throw new ConflictError(
			`Project agent WIP limit reached (${cap}); currently held: ${held.join(", ")}`
		);
	}

	const row = await orm
		.select()
		.from(schema.issueLeases)
		.where(eq(schema.issueLeases.id, id))
		.get();
	// biome-ignore lint/style/noNonNullAssertion: row was just inserted; SELECT immediately after guarantees it exists
	return row!;
}

/** Release the active lease on an issue, optionally only if held by `agentId`. */
export async function releaseIssue(ctx: ServiceCtx, raw: unknown) {
	const result = ReleaseIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, agentId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);

	const conditions = [
		eq(schema.issueLeases.workspaceId, ctx.workspaceId),
		eq(schema.issueLeases.issueId, issueId),
		isNull(schema.issueLeases.releasedAt),
	];
	if (agentId) conditions.push(eq(schema.issueLeases.agentSessionId, agentId));

	const active = await orm
		.select({ id: schema.issueLeases.id })
		.from(schema.issueLeases)
		.where(and(...conditions))
		.get();
	if (!active) throw new NotFoundError("No active lease on this issue");

	await orm
		.update(schema.issueLeases)
		.set({ releasedAt: now, releaseReason: "released" })
		.where(eq(schema.issueLeases.id, active.id));

	return { ok: true };
}

/** Release every active lease held by an agent session (called when it ends). */
export async function releaseLeasesForAgent(ctx: ServiceCtx, agentSessionId: string) {
	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);

	await orm
		.update(schema.issueLeases)
		.set({ releasedAt: now, releaseReason: "agent_ended" })
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				eq(schema.issueLeases.agentSessionId, agentSessionId),
				isNull(schema.issueLeases.releasedAt)
			)
		);
}

/**
 * The set of issue ids currently held by a LIVE lease (active row + live
 * session). Used by get_prioritized_issues' excludeClaimed filter.
 */
export async function liveLeasedIssueIds(ctx: ServiceCtx): Promise<Set<string>> {
	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({ issueId: schema.issueLeases.issueId })
		.from(schema.issueLeases)
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				isNull(schema.issueLeases.releasedAt),
				eq(schema.agentSessions.status, "active"),
				gt(schema.agentSessions.lastHeartbeatAt, liveCutoff())
			)
		);
	return new Set(rows.map((r) => r.issueId));
}

/**
 * Is there a LIVE lease on this issue, held by any session regardless of its
 * self-declared kind? This is the authoritative "an agent is actively working
 * this issue" signal used by the review/done gate (PROJ-287), replacing the
 * spoofable caller-supplied agentSessionId/kind. Gating deliberately ignores
 * agentSessions.kind — a session's kind is self-declared at register_agent
 * time with no privilege check, so a caller could register kind:"human",
 * claim the issue, and mark it done directly if the gate trusted that label.
 * Holding a lease at all is what triggers the gate, not the declared kind.
 */
export async function issueHasLiveAgentLease(ctx: ServiceCtx, issueId: string): Promise<boolean> {
	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ id: schema.issueLeases.id })
		.from(schema.issueLeases)
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				eq(schema.issueLeases.issueId, issueId),
				isNull(schema.issueLeases.releasedAt),
				eq(schema.agentSessions.status, "active"),
				gt(schema.agentSessions.lastHeartbeatAt, liveCutoff())
			)
		)
		.get();
	return row != null;
}

/**
 * Has this issue EVER been leased by any session (live, released, or stale),
 * regardless of its self-declared kind — see issueHasLiveAgentLease for why
 * kind is ignored. Scopes the human-done completion-report requirement to
 * agent-worked issues (PROJ-289) so closing ordinary human/duplicate/won't-fix
 * issues isn't blocked for a report no agent was ever going to write.
 */
export async function issueEverHadAgentLease(ctx: ServiceCtx, issueId: string): Promise<boolean> {
	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ id: schema.issueLeases.id })
		.from(schema.issueLeases)
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				eq(schema.issueLeases.issueId, issueId)
			)
		)
		.get();
	return row != null;
}

/**
 * List active leases (released_at IS NULL) in the workspace, optionally scoped
 * to an issue or agent. Each row carries a `live` flag (false = the holder
 * stopped heartbeating and the lease is reclaimable).
 */
export async function listIssueLeases(ctx: ServiceCtx, raw: unknown) {
	const result = ListIssueLeasesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, agentId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const cutoff = liveCutoff();

	const conditions = [
		eq(schema.issueLeases.workspaceId, ctx.workspaceId),
		isNull(schema.issueLeases.releasedAt),
	];
	if (issueId) conditions.push(eq(schema.issueLeases.issueId, issueId));
	if (agentId) conditions.push(eq(schema.issueLeases.agentSessionId, agentId));

	// PROJ-316: a non-admin member only sees leases on issues whose project they
	// can access; owner/admin (predicate undefined) see every lease.
	const vis = visibleProjectPredicate(
		ctx,
		sql`(SELECT i.project_id FROM issues i WHERE i.id = ${schema.issueLeases.issueId})`
	);
	if (vis) conditions.push(vis);

	const rows = await orm
		.select({
			id: schema.issueLeases.id,
			issueId: schema.issueLeases.issueId,
			agentSessionId: schema.issueLeases.agentSessionId,
			agentName: schema.agentSessions.name,
			claimedAt: schema.issueLeases.claimedAt,
			sessionStatus: schema.agentSessions.status,
			sessionHeartbeat: schema.agentSessions.lastHeartbeatAt,
		})
		.from(schema.issueLeases)
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.where(and(...conditions))
		.orderBy(schema.issueLeases.claimedAt);

	const items = rows.map((r) => ({
		id: r.id,
		issueId: r.issueId,
		agentSessionId: r.agentSessionId,
		agentName: r.agentName,
		claimedAt: r.claimedAt,
		live: r.sessionStatus === "active" && r.sessionHeartbeat > cutoff,
	}));

	return { items };
}
