import { drizzle, schema } from "@projektor/db";
import { and, type Column, desc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";
import {
	EndAgentSchema,
	FinishWorkSchema,
	HeartbeatAgentSchema,
	ListActiveAgentsSchema,
	RegisterAgentSchema,
	StartWorkSchema,
} from "../schemas/agents";
import { ISSUE_REF_PATTERN } from "../schemas/common";
import { visibleProjectPredicate } from "./access";
import { resolveAgentSessionId, SESSION_TTL_SECONDS } from "./agent-identity";
import { buildGuardedMessageInsert } from "./agent-messages";
import { flattenWithPaths, NotFoundError, ValidationError } from "./errors";
import { buildReleaseClaimsForAgentStatement, claimFilesResolved } from "./file-claims";
import {
	buildLeaseClaimStatements,
	buildReleaseLeasesForAgentStatement,
	leaseHeldError,
	readLeaseClaimState,
	settleLeaseClaim,
} from "./issue-leases";
import { resolveOptionalIssueId, resolveVisibleIssueIdParam } from "./issue-ref";
import { updateIssue } from "./issues";
import { resolveVisibleProjectIdParam } from "./projects";
import type { ServiceCtx } from "./types";

// PROJ-336: agent_sessions.kind is caller-declared at register_agent with no
// privilege check (the original review-gate spoof vector; PROJ-287 rebound the
// gate to live leases instead, ignoring kind entirely). It drives no remaining
// behavior, so it's excluded here to stop it reading as a trust/attribution
// signal in list_active_agents and register/heartbeat/end responses.
const AGENT_SESSION_COLUMNS = {
	id: schema.agentSessions.id,
	workspaceId: schema.agentSessions.workspaceId,
	issueId: schema.agentSessions.issueId,
	tokenId: schema.agentSessions.tokenId,
	name: schema.agentSessions.name,
	status: schema.agentSessions.status,
	startedAt: schema.agentSessions.startedAt,
	lastHeartbeatAt: schema.agentSessions.lastHeartbeatAt,
	endedAt: schema.agentSessions.endedAt,
};

function isApiTokenMethod(method: string): boolean {
	return method === "pk" || method === "pat";
}

export async function registerAgent(ctx: ServiceCtx, raw: unknown) {
	const result = RegisterAgentSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { name } = result.data;
	const issueId = await resolveOptionalIssueId(ctx, result.data.issueId);
	if (issueId?.startsWith("unresolved:")) throw new NotFoundError("Issue not found");

	const { statement, row } = buildSessionInsert(ctx, {
		id: crypto.randomUUID(),
		name,
		issueId,
		now: Math.floor(Date.now() / 1000),
	});
	await statement.run();
	return row;
}

type AgentSessionRow = Pick<
	typeof schema.agentSessions.$inferSelect,
	| "id"
	| "workspaceId"
	| "issueId"
	| "tokenId"
	| "name"
	| "status"
	| "startedAt"
	| "lastHeartbeatAt"
	| "endedAt"
>;

function buildSessionInsert(
	ctx: ServiceCtx,
	input: Readonly<{ id: string; name: string; issueId: string | undefined; now: number }>
): { statement: D1PreparedStatement; row: AgentSessionRow } {
	const row: AgentSessionRow = {
		id: input.id,
		workspaceId: ctx.workspaceId,
		issueId: input.issueId ?? null,
		tokenId:
			ctx.auth?.credentialId && isApiTokenMethod(ctx.auth.method) ? ctx.auth.credentialId : null,
		name: input.name,
		status: "active",
		startedAt: input.now,
		lastHeartbeatAt: input.now,
		endedAt: null,
	};
	const query = drizzle(ctx.db, { schema })
		.insert(schema.agentSessions)
		.values({
			...row,
			authMethod: ctx.auth?.method ?? null,
			credentialId: ctx.auth?.credentialId ?? null,
		})
		.toSQL();
	return { statement: ctx.db.prepare(query.sql).bind(...query.params), row };
}

function sessionRowFromRaw(r: Record<string, unknown>): AgentSessionRow {
	return {
		id: r.id,
		workspaceId: r.workspace_id,
		issueId: r.issue_id,
		tokenId: r.token_id,
		name: r.name,
		status: r.status,
		startedAt: r.started_at,
		lastHeartbeatAt: r.last_heartbeat_at,
		endedAt: r.ended_at,
	} as AgentSessionRow;
}

/**
 * PROJ-929: register_agent + claim_issue + claim_files (if paths given) + post_message
 * in one call, replacing that 4-call sequence with the caller's own conflict handling
 * intact — claimIssue/claimFiles throw the same ConflictError/ValidationError they
 * always have, unchanged.
 *
 * All-or-nothing with compensating cleanup: D1 has no cross-call interactive
 * transaction, so this is a compensating-action sequence rather than a
 * single atomic write. If claim_issue or claim_files fails after the session was
 * registered, the session is ended immediately (which also releases anything it did
 * manage to claim before the failure), so no live, unaccounted-for session/lease/claim
 * is left behind by a failed start_work call in the ordinary case. If the process
 * itself crashes mid-call (so the compensating end_agent never runs), the claims it
 * made are still reclaimable by the next caller once the session's heartbeat goes
 * stale after SESSION_TTL_SECONDS (120s) — see claim_issue/claim_files's stale-holder reclaim.
 */
export async function startWork(ctx: ServiceCtx, raw: unknown) {
	const result = StartWorkSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { paths, name } = result.data;
	const issueId = ISSUE_REF_PATTERN.test(result.data.issue)
		? await resolveVisibleIssueIdParam(ctx, result.data.issue)
		: result.data.issue;

	const now = Math.floor(Date.now() / 1000);
	const cutoff = now - SESSION_TTL_SECONDS;
	const state = await readLeaseClaimState(ctx, { issueId, agentId: null, cutoff });
	if (state.holder?.live) throw leaseHeldError(state, now);

	const sessionId = crypto.randomUUID();
	const leaseId = crypto.randomUUID();
	const { statement: sessionInsert, row: session } = buildSessionInsert(ctx, {
		id: sessionId,
		name,
		issueId,
		now,
	});
	const plan = buildLeaseClaimStatements(ctx, {
		issueId,
		agentId: sessionId,
		state,
		cutoff,
		now,
		touchHeartbeat: false,
		leaseId,
	});
	const claimsFiles = paths !== undefined && paths.length > 0;
	const startMessage = buildGuardedMessageInsert(
		ctx,
		{ scope: `issue:${issueId}`, agentId: sessionId, body: `${name} started work` },
		claimsFiles
			? { sql: "1 = 1", params: [] }
			: {
					sql: "EXISTS (SELECT 1 FROM issue_leases WHERE id = ? AND workspace_id = ?)",
					params: [leaseId, ctx.workspaceId],
				}
	);
	const results = await ctx.db.batch([
		sessionInsert,
		...plan.statements,
		...(claimsFiles ? [] : [startMessage.statement]),
	]);

	try {
		const lease = await settleLeaseClaim(ctx, plan, results[1 + plan.insertIndex]);
		const claimed = claimsFiles
			? await claimFilesResolved(ctx, {
					issueId,
					projectId: state.projectId,
					agentId: session.id,
					paths,
					extraStatements: [startMessage.statement],
				})
			: null;
		return { sessionId: session.id, lease, claimedFiles: claimed?.created ?? [] };
	} catch (err) {
		try {
			await endSessionById(ctx, session.id);
		} catch (cleanupErr) {
			console.error("startWork: compensating endAgent failed", cleanupErr);
		}
		throw err;
	}
}

function sessionVisibleSql(ctx: ServiceCtx, issueIdExpr: Column | SQL): SQL {
	const vis = visibleProjectPredicate(
		ctx,
		sql`(SELECT project_id FROM issues WHERE id = ${issueIdExpr} AND workspace_id = ${ctx.workspaceId})`
	);
	return vis ? (or(isNull(issueIdExpr), vis) ?? vis) : sql`1 = 1`;
}

export async function heartbeatAgent(ctx: ServiceCtx, raw: unknown) {
	const result = HeartbeatAgentSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	// PROJ-894: heartbeat resolves against still-active sessions (not only live ones) —
	// this call is what revives a session that just went stale.
	const id = await resolveAgentSessionId(ctx, result.data.id, { includeStale: true });

	const row = await drizzle(ctx.db, { schema })
		.update(schema.agentSessions)
		.set({ lastHeartbeatAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(schema.agentSessions.id, id),
				eq(schema.agentSessions.workspaceId, ctx.workspaceId),
				eq(schema.agentSessions.status, "active"),
				sessionVisibleSql(ctx, schema.agentSessions.issueId)
			)
		)
		.returning(AGENT_SESSION_COLUMNS)
		.get();
	if (!row) throw new NotFoundError("Agent session not found");
	return row;
}

export async function endAgent(ctx: ServiceCtx, raw: unknown) {
	const result = EndAgentSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const id = await resolveAgentSessionId(ctx, result.data.id, { includeStale: true });
	return endSessionById(ctx, id);
}

async function endSessionById(ctx: ServiceCtx, id: string): Promise<AgentSessionRow> {
	const visibleSession = sql`EXISTS (
		SELECT 1 FROM agent_sessions s
		WHERE s.id = ${id} AND s.workspace_id = ${ctx.workspaceId}
		AND ${sessionVisibleSql(ctx, sql.raw("s.issue_id"))}
	)`;
	const update = drizzle(ctx.db, { schema })
		.update(schema.agentSessions)
		.set({ status: "ended", endedAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(schema.agentSessions.id, id),
				eq(schema.agentSessions.workspaceId, ctx.workspaceId),
				sessionVisibleSql(ctx, schema.agentSessions.issueId)
			)
		)
		.returning(AGENT_SESSION_COLUMNS)
		.toSQL();
	const results = await ctx.db.batch([
		buildReleaseClaimsForAgentStatement(ctx, id, visibleSession),
		buildReleaseLeasesForAgentStatement(ctx, id, visibleSession),
		ctx.db.prepare(update.sql).bind(...update.params),
	]);
	const raw = results[2].results[0] as Record<string, unknown> | undefined;
	if (!raw) throw new NotFoundError("Agent session not found");
	return sessionRowFromRaw(raw);
}

/**
 * PROJ-929: optionally transitions the issue via the existing updateIssue path (so
 * completion-report/review-gate rules apply exactly as they do for a plain
 * update_issue call), then ends the session — which already releases every claim and
 * lease it holds (see endAgent). Replaces release_issue + release_files + end_agent
 * (+ an update_issue call, if the issue is being closed) with one call.
 */
export async function finishWork(ctx: ServiceCtx, raw: unknown) {
	const result = FinishWorkSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(flattenWithPaths(result.error));
	const { sessionId, completionReport, status } = result.data;

	let extra: Record<string, unknown> = {};
	if (status !== undefined || completionReport !== undefined) {
		const updated = await updateIssue(ctx, result.data.issue, {
			...(status !== undefined ? { status } : {}),
			...(completionReport !== undefined ? { completionReport } : {}),
			// Attributes the transition to this session for the PROJ-375 audit flag and
			// the review-gate's completion-report requirement, exactly as a caller passing
			// agentSessionId on a plain update_issue already does.
			agentSessionId: sessionId,
		});
		// PROJ-961/962: surface followUp / parentReadyToClose / parentClosed from the update.
		const { ok: _ok, ...rest } = updated;
		extra = rest;
	} else {
		await resolveVisibleIssueIdParam(ctx, result.data.issue);
	}

	const ended = await endSessionById(ctx, sessionId);
	return Object.keys(extra).length > 0 ? { ...ended, ...extra } : ended;
}

/**
 * PROJ-932: defaults to live entries only (status='active' AND heartbeat inside the
 * TTL) — this list was already live-only before PROJ-932; what's new is `includeStale`,
 * which surfaces a session that is still `active` but has stopped heartbeating (a
 * crashed agent whose staleness the fleet might want to see). An `ended` session is
 * never returned, with or without `includeStale` — that flag widens the heartbeat
 * check, it doesn't reach into ended sessions. Each item carries a `live` boolean
 * (true when its heartbeat is inside the TTL) and, when linked to an issue, that
 * issue's display ref (issueRef, e.g. "PROJ-857").
 */
export async function listActiveAgents(ctx: ServiceCtx, raw: unknown) {
	const result = ListActiveAgentsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { includeStale } = result.data;
	const issueId = await resolveOptionalIssueId(ctx, result.data.issueId);
	const projectId = result.data.projectId
		? await resolveVisibleProjectIdParam(ctx, result.data.projectId)
		: undefined;

	const orm = drizzle(ctx.db, { schema });
	const cutoff = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;

	// `status='active'` is unconditional — an ended session is never returned, whether or
	// not includeStale is set. includeStale only lifts the heartbeat-freshness check below.
	const conditions = [
		eq(schema.agentSessions.workspaceId, ctx.workspaceId),
		eq(schema.agentSessions.status, "active"),
	];
	if (!includeStale) {
		conditions.push(gt(schema.agentSessions.lastHeartbeatAt, cutoff));
	}

	if (issueId) {
		conditions.push(eq(schema.agentSessions.issueId, issueId));
	}
	// PROJ-932: a session with no issue link has no project to check, so it's excluded
	// once a projectId filter is given (see the list_active_agents tool description).
	if (projectId) {
		conditions.push(eq(schema.issues.projectId, projectId));
	}

	// PROJ-316: a non-admin member only sees agents working an issue in a project
	// they can access. Agents not tied to any issue carry no project, so they stay
	// workspace-visible. Owner/admin (predicate undefined) see every agent. The LEFT
	// JOIN to issues below lets the predicate take the joined project id column
	// directly instead of a correlated subquery.
	const vis = visibleProjectPredicate(ctx, schema.issues.projectId);
	if (vis) {
		conditions.push(or(isNull(schema.agentSessions.issueId), vis) ?? vis);
	}

	const rows = await orm
		.select({
			...AGENT_SESSION_COLUMNS,
			projectKey: schema.projects.key,
			issueNumber: schema.issues.number,
		})
		.from(schema.agentSessions)
		.leftJoin(
			schema.issues,
			and(
				eq(schema.agentSessions.issueId, schema.issues.id),
				eq(schema.issues.workspaceId, ctx.workspaceId)
			)
		)
		.leftJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.where(and(...conditions))
		.orderBy(desc(schema.agentSessions.startedAt));

	const items = rows.map(({ projectKey, issueNumber, ...session }) => ({
		...session,
		issueRef: session.issueId && projectKey ? `${projectKey}-${issueNumber}` : null,
		live: session.lastHeartbeatAt > cutoff,
	}));

	return { items };
}
