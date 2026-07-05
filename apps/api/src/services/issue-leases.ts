import { drizzle, schema } from "@projektor/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
	ClaimIssueSchema,
	ListIssueLeasesSchema,
	ReleaseIssueSchema,
} from "../schemas/issue-leases";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

// Mirrors ACTIVE_TTL in services/agents.ts: a session (and therefore its leases)
// is live only while it has heartbeat within this window. Kept local to avoid a
// circular import (agents.ts already imports releaseLeasesForAgent from here).
const SESSION_TTL_SECONDS = 120;

const liveCutoff = () => Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;

async function assertIssueExists(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	issueId: string
): Promise<void> {
	const issue = await orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (!issue) throw new NotFoundError("Issue not found");
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
 * Claim an issue for an agent session. Atomic: the partial UNIQUE index on
 * (workspace_id, issue_id) WHERE released_at IS NULL guarantees at most one
 * active lease per issue, so two concurrent claims can't both succeed — the
 * loser hits the constraint and is reported as a conflict. A lease whose owning
 * session has gone stale (stopped heartbeating) is reclaimed transparently.
 */
export async function claimIssue(ctx: ServiceCtx, raw: unknown) {
	const result = ClaimIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, agentId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const cutoff = liveCutoff();

	await assertIssueExists(orm, ctx, issueId);
	await assertAgentSessionLive(orm, ctx, agentId, cutoff);

	const now = Math.floor(Date.now() / 1000);
	await reclaimStaleLeaseOrThrow(orm, ctx, issueId, cutoff, now);

	const id = crypto.randomUUID();
	try {
		await orm.insert(schema.issueLeases).values({
			id,
			workspaceId: ctx.workspaceId,
			issueId,
			agentSessionId: agentId,
			claimedAt: now,
			releasedAt: null,
			releaseReason: null,
		});
	} catch (e) {
		// Lost a genuine race: another claim inserted the active lease first and
		// the partial UNIQUE index rejected ours.
		if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
			throw new ConflictError("Issue was just leased by another agent");
		}
		throw e;
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
