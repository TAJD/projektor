import { drizzle, schema } from "@projektor/db";
import { and, eq, gt, isNull, type SQL } from "drizzle-orm";
import { ISSUE_REF_PATTERN } from "../schemas/common";
import {
	ClaimIssueSchema,
	ListIssueLeasesSchema,
	ReleaseIssueSchema,
} from "../schemas/issue-leases";
import { visibleProjectPredicate, visibleProjectSqlFragment } from "./access";
import { resolveAgentSessionId } from "./agent-identity";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { resolveOptionalIssueId, resolveVisibleIssueIdParam } from "./issue-ref";
import { resolveVisibleProjectIdParam } from "./projects";
import { broadcastWorkspaceEvent } from "./realtime";
import type { ServiceCtx } from "./types";

// Mirrors ACTIVE_TTL in services/agents.ts: a session (and therefore its leases)
// is live only while it has heartbeat within this window. Kept local to avoid a
// circular import (agents.ts already imports releaseLeasesForAgent from here).
export const SESSION_TTL_SECONDS = 120;

const liveCutoff = () => Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;

// PROJ-253: per-project agent WIP cap, used when a project doesn't set its own
// projects.agent_wip_limit.
const DEFAULT_AGENT_WIP_LIMIT = 3;

type IssueLeaseRow = typeof schema.issueLeases.$inferSelect;

// The project's agent WIP cap (its own agent_wip_limit, else the default).
export async function fetchAgentWipCap(
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

// PROJ-929: statement-builder for callers (e.g. updateIssue, claimIssue) that fold the
// heartbeat refresh into their own ctx.db.batch(). Gated on status='active' AND
// heartbeat > cutoff so it never revives a stale session (PROJ-636 stale-holder reclaim).
export function buildTouchAgentHeartbeatIfLiveStatement(
	ctx: ServiceCtx,
	agentSessionId: string
): D1PreparedStatement {
	const orm = drizzle(ctx.db, { schema });
	const query = orm
		.update(schema.agentSessions)
		.set({ lastHeartbeatAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(schema.agentSessions.id, agentSessionId),
				eq(schema.agentSessions.workspaceId, ctx.workspaceId),
				eq(schema.agentSessions.status, "active"),
				gt(schema.agentSessions.lastHeartbeatAt, liveCutoff())
			)
		)
		.toSQL();
	return ctx.db.prepare(query.sql).bind(...query.params);
}

interface ClaimReadState {
	projectId: string;
	cap: number;
	holder: { leaseId: string; agentSessionId: string; live: boolean } | null;
	session: { status: string; heartbeat: number } | null;
}

function visibleIssueClause(ctx: ServiceCtx, column: string): { sql: string; params: unknown[] } {
	const vis = visibleProjectSqlFragment(ctx, column);
	return vis ? { sql: ` AND ${vis.sql}`, params: vis.params } : { sql: "", params: [] };
}

export async function readLeaseClaimState(
	ctx: ServiceCtx,
	input: Readonly<{ issueId: string; agentId: string | null; cutoff: number }>
): Promise<ClaimReadState> {
	const { issueId, agentId, cutoff } = input;
	const issueVis = visibleIssueClause(ctx, "i.project_id");
	const statements = [
		ctx.db
			.prepare(
				`SELECT i.project_id AS project_id, p.agent_wip_limit AS cap
				 FROM issues i
				 JOIN projects p ON p.id = i.project_id AND p.workspace_id = i.workspace_id
				 WHERE i.id = ? AND i.workspace_id = ?${issueVis.sql}`
			)
			.bind(issueId, ctx.workspaceId, ...issueVis.params),
		ctx.db
			.prepare(
				`SELECT il.id AS lease_id, il.agent_session_id AS agent_session_id,
				        (s.status = 'active' AND s.last_heartbeat_at > ?) AS live
				 FROM issue_leases il
				 JOIN issues i ON i.id = il.issue_id AND i.workspace_id = il.workspace_id
				 JOIN agent_sessions s ON s.id = il.agent_session_id AND s.workspace_id = il.workspace_id
				 WHERE il.workspace_id = ? AND il.issue_id = ? AND il.released_at IS NULL${issueVis.sql}
				 LIMIT 1`
			)
			.bind(cutoff, ctx.workspaceId, issueId, ...issueVis.params),
	];
	if (agentId) {
		statements.push(
			ctx.db
				.prepare(
					"SELECT status, last_heartbeat_at AS heartbeat FROM agent_sessions WHERE id = ? AND workspace_id = ?"
				)
				.bind(agentId, ctx.workspaceId)
		);
	}

	const [issueRes, holderRes, sessionRes] = await ctx.db.batch(statements);
	const issue = issueRes.results[0] as { project_id: string; cap: number | null } | undefined;
	if (!issue) throw new NotFoundError("Issue not found");
	const holder = holderRes.results[0] as
		| { lease_id: string; agent_session_id: string; live: number }
		| undefined;
	const session = sessionRes?.results[0] as { status: string; heartbeat: number } | undefined;
	return {
		projectId: issue.project_id,
		cap: issue.cap ?? DEFAULT_AGENT_WIP_LIMIT,
		holder: holder
			? {
					leaseId: holder.lease_id,
					agentSessionId: holder.agent_session_id,
					live: holder.live === 1,
				}
			: null,
		session: session ?? null,
	};
}

export function assertSessionLive(state: ClaimReadState, cutoff: number): void {
	if (!state.session) throw new NotFoundError("Agent session not found");
	if (state.session.status !== "active" || state.session.heartbeat <= cutoff) {
		throw new ValidationError({
			formErrors: ["Agent session is not live — heartbeat before claiming"],
			fieldErrors: {},
		});
	}
}

export function leaseHeldError(agentSessionId: string): ConflictError {
	return new ConflictError(`Issue is already leased by agent session ${agentSessionId}`);
}

export interface LeaseClaimPlan {
	statements: D1PreparedStatement[];
	insertIndex: number;
	lease: IssueLeaseRow;
	issueId: string;
	agentId: string;
	projectId: string;
	cap: number;
	cutoff: number;
	now: number;
}

export function buildLeaseClaimStatements(
	ctx: ServiceCtx,
	input: Readonly<{
		issueId: string;
		agentId: string;
		state: ClaimReadState;
		cutoff: number;
		now: number;
		touchHeartbeat: boolean;
		leaseId?: string;
	}>
): LeaseClaimPlan {
	const { issueId, agentId, state, cutoff, now } = input;
	const id = input.leaseId ?? crypto.randomUUID();
	const statements: D1PreparedStatement[] = [];

	if (input.touchHeartbeat) {
		statements.push(buildTouchAgentHeartbeatIfLiveStatement(ctx, agentId));
	}
	if (state.holder && !state.holder.live) {
		statements.push(
			ctx.db
				.prepare(
					`UPDATE issue_leases SET released_at = ?, release_reason = 'expired'
					 WHERE id = ? AND workspace_id = ? AND released_at IS NULL
					   AND NOT EXISTS (
					     SELECT 1 FROM agent_sessions s
					     WHERE s.id = issue_leases.agent_session_id
					       AND s.status = 'active' AND s.last_heartbeat_at > ?
					   )`
				)
				.bind(now, state.holder.leaseId, ctx.workspaceId, cutoff)
		);
	}

	const issueVis = visibleIssueClause(ctx, "i.project_id");
	const insertIndex = statements.length;
	statements.push(
		ctx.db
			.prepare(
				`INSERT OR IGNORE INTO issue_leases (id, workspace_id, issue_id, agent_session_id, claimed_at, released_at, release_reason)
				 SELECT ?, ?, ?, ?, ?, NULL, NULL
				 WHERE EXISTS (SELECT 1 FROM issues i WHERE i.id = ? AND i.workspace_id = ?${issueVis.sql})
				   AND (
				     SELECT COUNT(*) FROM issue_leases il
				     JOIN issues i ON i.id = il.issue_id
				     JOIN agent_sessions s ON s.id = il.agent_session_id
				     WHERE il.workspace_id = ? AND il.released_at IS NULL
				       AND i.project_id = ? AND s.status = 'active' AND s.last_heartbeat_at > ?
				   ) < ?`
			)
			.bind(
				id,
				ctx.workspaceId,
				issueId,
				agentId,
				now,
				issueId,
				ctx.workspaceId,
				...issueVis.params,
				ctx.workspaceId,
				state.projectId,
				cutoff,
				state.cap
			)
	);

	return {
		statements,
		insertIndex,
		lease: {
			id,
			workspaceId: ctx.workspaceId,
			issueId,
			agentSessionId: agentId,
			claimedAt: now,
			releasedAt: null,
			releaseReason: null,
		},
		issueId,
		agentId,
		projectId: state.projectId,
		cap: state.cap,
		cutoff,
		now,
	};
}

export async function settleLeaseClaim(
	ctx: ServiceCtx,
	plan: LeaseClaimPlan,
	insertResult: D1Result
): Promise<IssueLeaseRow> {
	if (insertResult.meta.changes === 0) {
		const { issueId, agentId, projectId, cap, cutoff, now } = plan;
		const vis = visibleIssueClause(ctx, "i.project_id");
		const [, active, holders] = await ctx.db.batch([
			ctx.db
				.prepare(
					`INSERT INTO wip_cap_denials (id, workspace_id, project_id, issue_id, agent_session_id, occurred_at)
					 SELECT ?, ?, ?, ?, ?, ?
					 WHERE NOT EXISTS (
					   SELECT 1 FROM issue_leases WHERE workspace_id = ? AND issue_id = ? AND released_at IS NULL
					 )`
				)
				.bind(
					crypto.randomUUID(),
					ctx.workspaceId,
					projectId,
					issueId,
					agentId,
					now,
					ctx.workspaceId,
					issueId
				),
			ctx.db
				.prepare(
					"SELECT 1 AS held FROM issue_leases WHERE workspace_id = ? AND issue_id = ? AND released_at IS NULL LIMIT 1"
				)
				.bind(ctx.workspaceId, issueId),
			ctx.db
				.prepare(
					`SELECT il.issue_id AS issue_id FROM issue_leases il
					 JOIN issues i ON i.id = il.issue_id
					 JOIN agent_sessions s ON s.id = il.agent_session_id
					 WHERE il.workspace_id = ? AND il.released_at IS NULL
					   AND i.project_id = ? AND s.status = 'active' AND s.last_heartbeat_at > ?${vis.sql}`
				)
				.bind(ctx.workspaceId, projectId, cutoff, ...vis.params),
		]);
		if (active.results.length > 0) {
			throw new ConflictError("Issue was just leased by another agent");
		}
		const held = (holders.results as Array<{ issue_id: string }>).map((h) => h.issue_id);
		throw new ConflictError(
			`Project agent WIP limit reached (${cap}); currently held: ${held.join(", ")}`
		);
	}

	await broadcastWorkspaceEvent(ctx, {
		type: "lease.claimed",
		projectId: plan.projectId,
		data: { issueId: plan.issueId, agentId: plan.agentId, id: plan.lease.id },
	});
	return plan.lease;
}

/**
 * Claim an issue for an agent session in one read batch and one write batch. The per-issue
 * partial UNIQUE index and the per-project WIP cap subquery are both enforced inside the
 * single INSERT (PROJ-290); a lease held by a stale session is reclaimed in the same write.
 */
export async function claimIssue(ctx: ServiceCtx, raw: unknown) {
	const result = ClaimIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const issueId =
		ISSUE_REF_PATTERN.test(result.data.issueId) || !result.data.agentId
			? await resolveVisibleIssueIdParam(ctx, result.data.issueId)
			: result.data.issueId;
	const agentId = await resolveAgentSessionId(ctx, result.data.agentId);

	const cutoff = liveCutoff();
	const now = Math.floor(Date.now() / 1000);
	const state = await readLeaseClaimState(ctx, { issueId, agentId, cutoff });
	assertSessionLive(state, cutoff);

	if (state.holder?.live) {
		await buildTouchAgentHeartbeatIfLiveStatement(ctx, agentId).run();
		throw leaseHeldError(state.holder.agentSessionId);
	}

	const plan = buildLeaseClaimStatements(ctx, {
		issueId,
		agentId,
		state,
		cutoff,
		now,
		touchHeartbeat: true,
	});
	const results = await ctx.db.batch(plan.statements);
	return settleLeaseClaim(ctx, plan, results[plan.insertIndex]);
}

/** Release the active lease on an issue, optionally only if held by `agentId`. */
export async function releaseIssue(ctx: ServiceCtx, raw: unknown) {
	const result = ReleaseIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { agentId } = result.data;
	const issueId = await resolveVisibleIssueIdParam(ctx, result.data.issueId);

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

	const issue = await orm
		.select({ projectId: schema.issues.projectId })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (!issue) throw new NotFoundError("Issue not found");

	await orm
		.update(schema.issueLeases)
		.set({ releasedAt: now, releaseReason: "released" })
		.where(eq(schema.issueLeases.id, active.id));

	await broadcastWorkspaceEvent(ctx, {
		type: "lease.released",
		projectId: issue.projectId,
		data: { issueId, agentId },
	});

	return { ok: true };
}

/**
 * Build (without executing) the UPDATE that releases the active lease on an issue when
 * it moves to done/cancelled (PROJ-928) — an issue closed by any path (human or agent)
 * shouldn't keep blocking the fleet on a lease no one is still working. Distinct
 * release_reason from releaseIssue's "released" so the factory-health tile can tell a
 * deliberate release from a close-triggered one. Returned as a statement (PROJ-870
 * convention) so the caller (updateIssue) folds it into its single ctx.db.batch() instead
 * of spending an extra D1 round trip.
 */
export function buildReleaseLeaseForClosedIssueStatement(
	ctx: ServiceCtx,
	issueId: string
): D1PreparedStatement {
	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);
	const query = orm
		.update(schema.issueLeases)
		.set({ releasedAt: now, releaseReason: "issue_closed" })
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				eq(schema.issueLeases.issueId, issueId),
				isNull(schema.issueLeases.releasedAt)
			)
		)
		.toSQL();
	return ctx.db.prepare(query.sql).bind(...query.params);
}

export function buildReleaseLeasesForAgentStatement(
	ctx: ServiceCtx,
	agentSessionId: string,
	guard?: SQL
): D1PreparedStatement {
	const orm = drizzle(ctx.db, { schema });
	const query = orm
		.update(schema.issueLeases)
		.set({ releasedAt: Math.floor(Date.now() / 1000), releaseReason: "agent_ended" })
		.where(
			and(
				eq(schema.issueLeases.workspaceId, ctx.workspaceId),
				eq(schema.issueLeases.agentSessionId, agentSessionId),
				isNull(schema.issueLeases.releasedAt),
				guard
			)
		)
		.toSQL();
	return ctx.db.prepare(query.sql).bind(...query.params);
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
 * One read for the review/done gate and the audit flag. everLeased: any lease, ever
 * (PROJ-289 scopes the done-report requirement to agent-worked issues). liveLease: a
 * live lease by any session (PROJ-287). sessionLive: agentSessionId is registered,
 * active and within the TTL (PROJ-375 audit flag). None trusts the session's
 * self-declared kind, which register_agent sets without a privilege check.
 */
export interface AgentWorkFlags {
	everLeased: boolean;
	liveLease: boolean;
	sessionLive: boolean;
}

export async function readAgentWorkFlags(
	ctx: ServiceCtx,
	issueId: string,
	agentSessionId: string | undefined
): Promise<AgentWorkFlags> {
	const cutoff = liveCutoff();
	const row = await ctx.db
		.prepare(
			`SELECT
			   EXISTS (SELECT 1 FROM issue_leases il JOIN agent_sessions s ON s.id = il.agent_session_id
			           WHERE il.workspace_id = ? AND il.issue_id = ?) AS ever_leased,
			   EXISTS (SELECT 1 FROM issue_leases il JOIN agent_sessions s ON s.id = il.agent_session_id
			           WHERE il.workspace_id = ? AND il.issue_id = ? AND il.released_at IS NULL
			             AND s.status = 'active' AND s.last_heartbeat_at > ?) AS live_lease,
			   EXISTS (SELECT 1 FROM agent_sessions
			           WHERE id = ? AND workspace_id = ? AND status = 'active' AND last_heartbeat_at > ?) AS session_live`
		)
		.bind(
			ctx.workspaceId,
			issueId,
			ctx.workspaceId,
			issueId,
			cutoff,
			agentSessionId ?? "",
			ctx.workspaceId,
			cutoff
		)
		.first<{ ever_leased: number; live_lease: number; session_live: number }>();
	return {
		everLeased: row?.ever_leased === 1,
		liveLease: row?.live_lease === 1,
		sessionLive: row?.session_live === 1,
	};
}

/**
 * List active leases (released_at IS NULL) in the workspace, optionally scoped
 * to an issue, agent or project. Each row carries a `live` flag (false = the
 * holder stopped heartbeating and the lease is reclaimable) and the linked
 * issue's display ref (issueRef, e.g. "PROJ-857").
 *
 * PROJ-932: defaults to live entries only — an unreleased lease whose agent
 * session has gone stale (ended, or heartbeat past the TTL) is excluded unless
 * `includeStale` is set, restoring the pre-PROJ-932 behaviour of returning
 * every unreleased lease regardless of session health.
 */
export async function listIssueLeases(ctx: ServiceCtx, raw: unknown) {
	const result = ListIssueLeasesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { agentId, includeStale } = result.data;
	const issueId = await resolveOptionalIssueId(ctx, result.data.issueId);
	const projectId = result.data.projectId
		? await resolveVisibleProjectIdParam(ctx, result.data.projectId)
		: undefined;

	const orm = drizzle(ctx.db, { schema });
	const cutoff = liveCutoff();

	const conditions = [
		eq(schema.issueLeases.workspaceId, ctx.workspaceId),
		isNull(schema.issueLeases.releasedAt),
	];
	if (issueId) conditions.push(eq(schema.issueLeases.issueId, issueId));
	if (agentId) conditions.push(eq(schema.issueLeases.agentSessionId, agentId));
	if (projectId) conditions.push(eq(schema.issues.projectId, projectId));
	if (!includeStale) {
		conditions.push(eq(schema.agentSessions.status, "active"));
		conditions.push(gt(schema.agentSessions.lastHeartbeatAt, cutoff));
	}

	// PROJ-316: a non-admin member only sees leases on issues whose project they
	// can access; owner/admin (predicate undefined) see every lease. Every lease is
	// joined to its issue below (issue_id is NOT NULL), so the predicate can take the
	// joined project id column directly instead of a correlated subquery.
	const vis = visibleProjectPredicate(ctx, schema.issues.projectId);
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
			projectKey: schema.projects.key,
			issueNumber: schema.issues.number,
		})
		.from(schema.issueLeases)
		.innerJoin(schema.agentSessions, eq(schema.issueLeases.agentSessionId, schema.agentSessions.id))
		.innerJoin(
			schema.issues,
			and(
				eq(schema.issueLeases.issueId, schema.issues.id),
				eq(schema.issues.workspaceId, ctx.workspaceId)
			)
		)
		.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.where(and(...conditions))
		.orderBy(schema.issueLeases.claimedAt);

	const items = rows.map((r) => ({
		id: r.id,
		issueId: r.issueId,
		issueRef: `${r.projectKey}-${r.issueNumber}`,
		agentSessionId: r.agentSessionId,
		agentName: r.agentName,
		claimedAt: r.claimedAt,
		live: r.sessionStatus === "active" && r.sessionHeartbeat > cutoff,
	}));

	return { items };
}
