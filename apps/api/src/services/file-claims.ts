import { drizzle, schema } from "@projektor/db";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { PostMessageSchema } from "../schemas/agent-messages";
import { ClaimFilesSchema, ListFileClaimsSchema, ReleaseFilesSchema } from "../schemas/file-claims";
import { visibleProjectPredicate } from "./access";
import { buildPostMessageStatements } from "./agent-messages";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { resolveIssueIdParam, resolveOptionalIssueId } from "./issue-ref";
import { resolveVisibleProjectIdParam } from "./projects";
import { broadcastWorkspaceEvent } from "./realtime";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

async function assertIssueInWorkspace(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	issueId: string
): Promise<string> {
	const issue = await orm
		.select({ projectId: schema.issues.projectId })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, workspaceId)))
		.get();
	if (!issue) throw new NotFoundError("Issue not found");
	return issue.projectId;
}

async function assertAgentInWorkspace(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	agentId: string
) {
	const agent = await orm
		.select({ id: schema.agentSessions.id })
		.from(schema.agentSessions)
		.where(
			and(eq(schema.agentSessions.id, agentId), eq(schema.agentSessions.workspaceId, workspaceId))
		)
		.get();
	if (!agent) throw new NotFoundError("Agent session not found");
}

// PROJ-929: a call that carries an already-live agentId implicitly refreshes that
// session's heartbeat, so explicit heartbeat_agent calls become optional during a claim
// loop. Local rather than imported from services/agents.ts for the same reason
// SESSION_TTL_SECONDS below is duplicated: agents.ts already imports from this file
// (releaseClaimsForAgent), so importing back would cycle.
//
// Deliberately gated on the session being live ALREADY (status='active' AND heartbeat
// > cutoff), not just active — otherwise this would revive a crashed agent's session
// merely because some other issue's claim/release call happened to name its id, which
// would silently defeat the PROJ-636 stale-holder reclaim this same file implements: a
// dead session must stay reclaimable, not get its heartbeat bumped by a call that isn't
// actually coming from it.
async function touchAgentHeartbeatIfLive(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	agentId: string,
	cutoff: number
): Promise<void> {
	await orm
		.update(schema.agentSessions)
		.set({ lastHeartbeatAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(schema.agentSessions.id, agentId),
				eq(schema.agentSessions.workspaceId, ctx.workspaceId),
				eq(schema.agentSessions.status, "active"),
				gt(schema.agentSessions.lastHeartbeatAt, cutoff)
			)
		);
}

// PROJ-636: mirrors SESSION_TTL_SECONDS in services/issue-leases.ts, which in turn mirrors
// ACTIVE_TTL in services/agents.ts. Kept local for the same reason theirs are: agents.ts
// already imports releaseClaimsForAgent from here, so importing back would cycle.
const SESSION_TTL_SECONDS = 120;

const liveCutoff = () => Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;

// PROJ-928: an agentless claim (agentId null — see loadActiveClaimsByPath) has no
// heartbeat to judge staleness by, so it used to be treated as live forever, reclaimable
// only via `force`. This TTL bounds that: after it elapses since claimedAt, the claim is
// reclaimed by the next claimer the same way a dead agent's claim is. Configurable via
// FILE_CLAIM_TTL_SECONDS (default 24h); invalid/non-positive values fall back to it.
//
// Fix-up: the raw env value is parsed once, in ctxFromHono, into ctx.config —
// never carried on ServiceCtx as a whole, which (PluginContext being shared by every
// service and MCP/plugin handler) would otherwise hand every tool every secret and
// binding. This function is exported so ctxFromHono can reuse the same parsing/default
// without duplicating it.
export const DEFAULT_FILE_CLAIM_TTL_SECONDS = 24 * 60 * 60;

export function parseFileClaimTtlSeconds(raw: string | undefined): number {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_FILE_CLAIM_TTL_SECONDS;
}

// The cutoff before which an agentless claim (no session to judge staleness by) counts as
// stale — see DEFAULT_FILE_CLAIM_TTL_SECONDS/parseFileClaimTtlSeconds above. Shared by
// claimFiles (stale-holder reclaim) and listFileClaims (default live-only filter and the
// `live` flag) so the two definitions of "stale" can't drift apart.
function fileClaimAgentlessCutoff(ctx: ServiceCtx, now: number): number {
	return now - (ctx.config?.fileClaimTtlSeconds ?? DEFAULT_FILE_CLAIM_TTL_SECONDS);
}

// PROJ-932 fix-up: one SQL expression for "is this claim live", used both to filter
// listFileClaims' default listing and to populate the `live` flag on every row it
// returns — a single rule kept in one place so the filter and the flag can't silently
// disagree. Evaluates to 1/0: an agentless claim is judged by claimedAt against the TTL
// cutoff; an agent-linked claim by the session's status/heartbeat. Requires the query to
// LEFT JOIN agent_sessions on issue_file_claims.agent_id, as listFileClaims does.
function fileClaimLiveExpr(cutoff: number, agentlessCutoff: number) {
	return sql<number>`(CASE
		WHEN ${schema.issueFileClaims.agentId} IS NULL THEN (${schema.issueFileClaims.claimedAt} > ${agentlessCutoff})
		ELSE (${schema.agentSessions.status} = 'active' AND ${schema.agentSessions.lastHeartbeatAt} > ${cutoff})
	END)`;
}

type ActiveClaim = typeof schema.issueFileClaims.$inferSelect & { live: boolean };

// inChunks keeps each query under D1's 100-bound-parameter cap. See services/sql.ts.
async function loadActiveClaimsByPath(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	paths: string[],
	cutoff: number,
	agentlessCutoff: number
): Promise<Map<string, ActiveClaim>> {
	const activeClaims = await inChunks(paths, (chunk) =>
		orm
			// Columns enumerated rather than `.select()` because the session fields have to
			// come along; LEFT JOIN, not INNER, so an agentless claim still appears.
			.select({
				id: schema.issueFileClaims.id,
				workspaceId: schema.issueFileClaims.workspaceId,
				issueId: schema.issueFileClaims.issueId,
				agentId: schema.issueFileClaims.agentId,
				path: schema.issueFileClaims.path,
				claimedAt: schema.issueFileClaims.claimedAt,
				releasedAt: schema.issueFileClaims.releasedAt,
				releaseReason: schema.issueFileClaims.releaseReason,
				sessionStatus: schema.agentSessions.status,
				sessionHeartbeat: schema.agentSessions.lastHeartbeatAt,
			})
			.from(schema.issueFileClaims)
			.leftJoin(schema.agentSessions, eq(schema.issueFileClaims.agentId, schema.agentSessions.id))
			.where(
				and(
					eq(schema.issueFileClaims.workspaceId, workspaceId),
					inArray(schema.issueFileClaims.path, chunk),
					isNull(schema.issueFileClaims.releasedAt)
				)
			)
	);
	return new Map(
		activeClaims.map(({ sessionStatus, sessionHeartbeat, ...claim }) => [
			claim.path,
			{
				...claim,
				// agentId is nullable — a claim can be made without a session, and the
				// agent_id FK is ON DELETE SET NULL. There is no heartbeat to judge those by,
				// so staleness is judged by claim age instead (PROJ-928): live until
				// FILE_CLAIM_TTL_SECONDS has elapsed since claimedAt, then reclaimable by the
				// next claimer just like a claim whose agent session went stale.
				live:
					claim.agentId === null
						? claim.claimedAt > agentlessCutoff
						: sessionStatus === "active" && (sessionHeartbeat ?? 0) > cutoff,
			},
		])
	);
}

// PROJ-864: multi-row insert chunk sizes, calibrated per-statement for D1's 100-bound-param
// cap with headroom — unlike services/sql.ts#inChunks, which is calibrated for single-param
// IN-list queries, not multi-column inserts. More chunks costs nothing here: every statement
// these produce is folded into one ctx.db.batch() call by the caller, so it's the number of
// batch() calls that's bounded (the AC), not the number of statements inside one.
const CLAIM_INSERT_CHUNK_SIZE = 10; // 7 cols/row
const CONFLICT_INSERT_CHUNK_SIZE = 8; // 9 cols/row
// Single-param-per-item IN-list chunk size for id-keyed UPDATEs, mirroring services/sql.ts.
const ID_CHUNK_SIZE = 90;

function toD1Statement(
	ctx: ServiceCtx,
	query: Readonly<{ sql: string; params: unknown[] }>
): D1PreparedStatement {
	return ctx.db.prepare(query.sql).bind(...query.params);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
	return out;
}

// Builds (without executing) the UPDATEs that release a set of claims by id, all with the
// same releasedAt/reason — used for stale-holder reclaim, force-override release and
// releaseFiles. The workspace and still-active guards mean a claim another request
// released in the meantime is left as that request wrote it; RETURNING id lets the
// caller report only the rows this batch actually released (releasedIdsFrom below).
function buildReleaseByIdsStatements(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	ids: readonly string[],
	now: number,
	reason: string
): D1PreparedStatement[] {
	return chunk(ids, ID_CHUNK_SIZE).map((idChunk) =>
		toD1Statement(
			ctx,
			orm
				.update(schema.issueFileClaims)
				.set({ releasedAt: now, releaseReason: reason })
				.where(
					and(
						eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
						inArray(schema.issueFileClaims.id, idChunk),
						isNull(schema.issueFileClaims.releasedAt)
					)
				)
				.returning({ id: schema.issueFileClaims.id })
				.toSQL()
		)
	);
}

function releasedIdsFrom(results: readonly D1Result[]): Set<string> {
	return new Set(results.flatMap((r) => (r.results as Array<{ id: string }>).map((row) => row.id)));
}

// PostMessageSchema's body cap: force-claim notifications are built server-side and
// inserted without re-validation (buildPostMessageStatements), so they must respect it
// themselves.
const MESSAGE_BODY_MAX = PostMessageSchema.shape.body.maxLength ?? 5000;

// Quoted, comma-separated paths, cut short with "…and N more" so the result (plus the
// caller's `overhead` characters of surrounding text) fits within MESSAGE_BODY_MAX.
function formatPathList(paths: readonly string[], overhead: number): string {
	const max = MESSAGE_BODY_MAX - overhead;
	let out = "";
	for (let i = 0; i < paths.length; i++) {
		const next = out ? `${out}, "${paths[i]}"` : `"${paths[i]}"`;
		const remaining = paths.length - i - 1;
		const tail = remaining > 0 ? `, …and ${remaining} more` : "";
		if (next.length + tail.length > max) {
			return `${out}${out ? ", " : ""}…and ${paths.length - i} more`;
		}
		out = next;
	}
	return out;
}

function buildConflictInsertStatements(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	rows: readonly (typeof schema.claimConflicts.$inferInsert)[]
): D1PreparedStatement[] {
	return chunk(rows, CONFLICT_INSERT_CHUNK_SIZE).map((rowChunk) =>
		toD1Statement(ctx, orm.insert(schema.claimConflicts).values(rowChunk).toSQL())
	);
}

function buildClaimInsertStatements(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	rows: readonly (typeof schema.issueFileClaims.$inferInsert)[]
): D1PreparedStatement[] {
	return chunk(rows, CLAIM_INSERT_CHUNK_SIZE).map((rowChunk) =>
		toD1Statement(ctx, orm.insert(schema.issueFileClaims).values(rowChunk).toSQL())
	);
}

export async function claimFiles(ctx: ServiceCtx, raw: unknown) {
	const result = ClaimFilesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { agentId, force } = result.data;
	const issueId = await resolveIssueIdParam(ctx, result.data.issueId);
	// A path listed twice would insert two active claims on it in one batch, which the
	// active-claim unique index rejects (rolling the whole batch back). Claim it once,
	// keeping the caller's order.
	const paths = [...new Set(result.data.paths)];

	const orm = drizzle(ctx.db, { schema });

	const projectId = await assertIssueInWorkspace(orm, ctx.workspaceId, issueId);
	if (agentId) {
		await assertAgentInWorkspace(orm, ctx.workspaceId, agentId);
		// PROJ-929: refresh the acting session's heartbeat if it's already live (see
		// touchAgentHeartbeatIfLive) — done even if the claim itself is later rejected below.
		await touchAgentHeartbeatIfLive(orm, ctx, agentId, liveCutoff());
	}

	// Pre-check all paths for active claims — all-or-nothing on conflict.
	const now = Math.floor(Date.now() / 1000);
	const claimsByPath = await loadActiveClaimsByPath(
		orm,
		ctx.workspaceId,
		paths,
		liveCutoff(),
		fileClaimAgentlessCutoff(ctx, now)
	);

	// PROJ-636: split stale holders out before conflict evaluation — a dead holder neither
	// blocks the claim nor lands in claim_conflicts. Same semantics as before reclaimStaleClaims
	// was inlined here; the release itself is now just one statement folded into the batch
	// below instead of an immediate per-claim UPDATE.
	const stale: ActiveClaim[] = [];
	for (const [path, claim] of claimsByPath) {
		if (!claim.live) {
			stale.push(claim);
			claimsByPath.delete(path);
		}
	}
	const reclaimed = stale.map((c) => ({ ...c, releasedAt: now, releaseReason: "expired" }));

	const statements: D1PreparedStatement[] = buildReleaseByIdsStatements(
		ctx,
		orm,
		stale.map((c) => c.id),
		now,
		"expired"
	);

	// Every path in this request that's still (genuinely) held once stale claims are excluded.
	const contended = paths
		.map((path) => ({ path, existing: claimsByPath.get(path) }))
		.filter((p): p is { path: string; existing: ActiveClaim } => Boolean(p.existing));

	if (!force && contended.length > 0) {
		// Record every contended path (rejection is all-or-nothing, but each simultaneously
		// held path is its own contention signal for the heat map). The reclaim above and
		// these conflict records must persist even though the claim itself is rejected, so
		// they go out together before throwing.
		statements.push(
			...buildConflictInsertStatements(
				ctx,
				orm,
				contended.map(({ path, existing }) => ({
					id: crypto.randomUUID(),
					workspaceId: ctx.workspaceId,
					path,
					rejectedIssueId: issueId,
					rejectedAgentId: agentId ?? null,
					holdingIssueId: existing.issueId,
					holdingAgentId: existing.agentId,
					forced: 0,
					occurredAt: now,
				}))
			)
		);
		await ctx.db.batch(statements);
		const first = contended[0];
		throw new ConflictError(
			`Path "${first.path}" is held by issue ${first.existing.issueId}` +
				`${first.existing.agentId ? ` (agent ${first.existing.agentId})` : ""}`
		);
	}

	// force:true — release every contended claim and record the override, in the same batch
	// as everything else (no conflict is possible when force is false and contended is empty).
	const overridden: ActiveClaim[] = [];
	if (force && contended.length > 0) {
		const displacedPaths = new Map<string, string[]>();
		for (const { path, existing } of contended) {
			overridden.push({ ...existing, releasedAt: now, releaseReason: "overridden" });
			const list = displacedPaths.get(existing.issueId) ?? [];
			list.push(path);
			displacedPaths.set(existing.issueId, list);
		}
		statements.push(
			...buildReleaseByIdsStatements(
				ctx,
				orm,
				contended.map(({ existing }) => existing.id),
				now,
				"overridden"
			),
			...buildConflictInsertStatements(
				ctx,
				orm,
				contended.map(({ path, existing }) => ({
					id: crypto.randomUUID(),
					workspaceId: ctx.workspaceId,
					path,
					rejectedIssueId: issueId,
					rejectedAgentId: agentId ?? null,
					holdingIssueId: existing.issueId,
					holdingAgentId: existing.agentId,
					forced: 1,
					occurredAt: now,
				}))
			)
		);
		const messages: { scope: string; agentId?: string; body: string }[] = [];
		for (const [displacedIssueId, displacedIssuePaths] of displacedPaths) {
			const toHolder = (list: string) =>
				`force-claimed ${list}, overriding issue ${displacedIssueId}`;
			const toDisplaced = (list: string) =>
				`issue ${issueId} force-claimed ${list}, which this issue held`;
			messages.push({
				scope: `issue:${issueId}`,
				agentId: agentId ?? undefined,
				body: toHolder(formatPathList(displacedIssuePaths, toHolder("").length)),
			});
			messages.push({
				scope: `issue:${displacedIssueId}`,
				agentId: agentId ?? undefined,
				body: toDisplaced(formatPathList(displacedIssuePaths, toDisplaced("").length)),
			});
		}
		statements.push(...buildPostMessageStatements(ctx, orm, messages));
	}

	// Every field is caller-supplied or server-generated (id, timestamp), so the inserted
	// rows are built here directly — no RETURNING/re-SELECT needed (PROJ-864).
	const created = paths.map((path) => ({
		id: crypto.randomUUID(),
		workspaceId: ctx.workspaceId,
		issueId,
		agentId: agentId ?? null,
		path,
		claimedAt: now,
		releasedAt: null,
	}));
	statements.push(...buildClaimInsertStatements(ctx, orm, created));

	await ctx.db.batch(statements);

	await broadcastWorkspaceEvent(ctx, {
		type: "claims.created",
		projectId,
		data: { issueId, agentId, paths, count: created.length },
	});

	return { created, overridden, reclaimed };
}

export async function releaseFiles(ctx: ServiceCtx, raw: unknown) {
	const result = ReleaseFilesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { paths } = result.data;
	const issueId = await resolveOptionalIssueId(ctx, result.data.issueId);

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);

	// inChunks keeps each read under D1's 100-bound-parameter cap (paths are caller-scaled).
	// projectId is joined in directly (PROJ-864) so the broadcast below needs no follow-up
	// query, whether or not issueId was given.
	const toRelease = await inChunks(paths, (pathChunk) => {
		const conditions = [
			eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
			inArray(schema.issueFileClaims.path, pathChunk),
			isNull(schema.issueFileClaims.releasedAt),
		];
		if (issueId) {
			conditions.push(eq(schema.issueFileClaims.issueId, issueId));
		}
		return orm
			.select({
				id: schema.issueFileClaims.id,
				workspaceId: schema.issueFileClaims.workspaceId,
				issueId: schema.issueFileClaims.issueId,
				agentId: schema.issueFileClaims.agentId,
				path: schema.issueFileClaims.path,
				claimedAt: schema.issueFileClaims.claimedAt,
				releasedAt: schema.issueFileClaims.releasedAt,
				releaseReason: schema.issueFileClaims.releaseReason,
				projectId: schema.issues.projectId,
			})
			.from(schema.issueFileClaims)
			.innerJoin(schema.issues, eq(schema.issueFileClaims.issueId, schema.issues.id))
			.where(and(...conditions));
	});

	if (toRelease.length === 0) {
		return { released: [], count: 0 };
	}

	const releaseIds = toRelease.map((r) => r.id);
	const releaseStatements = buildReleaseByIdsStatements(ctx, orm, releaseIds, now, "released");
	const releasedIds = releasedIdsFrom(await ctx.db.batch(releaseStatements));

	// Every field is already known from the read above — the released row is just that
	// snapshot with releasedAt/releaseReason applied, so no re-SELECT is needed (PROJ-864).
	// Only rows this batch actually released count: one released by a concurrent request
	// between the read and the batch is someone else's release.
	const releasedRows = toRelease.filter((r) => releasedIds.has(r.id));
	if (releasedRows.length === 0) {
		return { released: [], count: 0 };
	}
	const released = releasedRows.map(({ projectId: _projectId, ...r }) => ({
		...r,
		releasedAt: now,
		releaseReason: "released",
	}));

	// Stamp projectId on the broadcast. When issueId is provided there is exactly one
	// project; otherwise released rows may span projects, so fan out one event per project.
	if (issueId) {
		await broadcastWorkspaceEvent(ctx, {
			type: "claims.released",
			projectId: releasedRows[0].projectId,
			data: { issueId, paths, count: released.length },
		});
	} else {
		const grouped = new Map<string, string[]>();
		for (const row of releasedRows) {
			const list = grouped.get(row.projectId) ?? [];
			list.push(row.path);
			grouped.set(row.projectId, list);
		}
		for (const [projectId, projectPaths] of grouped) {
			await broadcastWorkspaceEvent(ctx, {
				type: "claims.released",
				projectId,
				data: { issueId, paths: projectPaths, count: projectPaths.length },
			});
		}
	}

	return { released, count: released.length };
}

/**
 * PROJ-932: defaults to live entries only — an unreleased claim whose holder has gone
 * stale (agent-linked: session ended or heartbeat past the TTL; agentless: past
 * FILE_CLAIM_TTL_SECONDS since claimedAt) is excluded unless `includeStale` is set,
 * restoring the pre-PROJ-932 behaviour of returning every unreleased claim regardless
 * of holder health.
 */
export async function listFileClaims(ctx: ServiceCtx, raw: unknown) {
	const result = ListFileClaimsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { path, includeStale } = result.data;
	const issueId = await resolveOptionalIssueId(ctx, result.data.issueId);
	const projectId = result.data.projectId
		? await resolveVisibleProjectIdParam(ctx, result.data.projectId)
		: undefined;

	const orm = drizzle(ctx.db, { schema });

	const cutoff = liveCutoff();
	const now = Math.floor(Date.now() / 1000);
	const agentlessCutoff = fileClaimAgentlessCutoff(ctx, now);
	// PROJ-636/928: one rule for "is this claim live" (see fileClaimLiveExpr), reused below
	// for both the default listing's filter and every row's `live` flag — false means the
	// holder stopped heartbeating (or, for an agentless claim, its TTL elapsed) and the next
	// claim on that path will reclaim it. Without it a reclaimable claim is indistinguishable
	// from a held one, which would make the self-healing the docs now describe unobservable.
	const liveExpr = fileClaimLiveExpr(cutoff, agentlessCutoff);

	const conditions = [
		eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
		isNull(schema.issueFileClaims.releasedAt),
	];

	if (issueId) {
		conditions.push(eq(schema.issueFileClaims.issueId, issueId));
	}
	if (path) {
		conditions.push(eq(schema.issueFileClaims.path, path));
	}
	if (projectId) {
		conditions.push(eq(schema.issues.projectId, projectId));
	}
	if (!includeStale) {
		conditions.push(eq(liveExpr, 1));
	}

	// PROJ-316: a non-admin member only sees claims on issues whose project they can
	// access; owner/admin (predicate undefined) see every claim. Every claim is joined to
	// its issue below (issue_id is NOT NULL), so the predicate can take the joined project
	// id column directly instead of a correlated subquery.
	const vis = visibleProjectPredicate(ctx, schema.issues.projectId);
	if (vis) conditions.push(vis);

	const rows = await orm
		.select({
			id: schema.issueFileClaims.id,
			workspaceId: schema.issueFileClaims.workspaceId,
			issueId: schema.issueFileClaims.issueId,
			agentId: schema.issueFileClaims.agentId,
			path: schema.issueFileClaims.path,
			claimedAt: schema.issueFileClaims.claimedAt,
			releasedAt: schema.issueFileClaims.releasedAt,
			releaseReason: schema.issueFileClaims.releaseReason,
			projectKey: schema.projects.key,
			issueNumber: schema.issues.number,
			live: liveExpr,
		})
		.from(schema.issueFileClaims)
		.leftJoin(schema.agentSessions, eq(schema.issueFileClaims.agentId, schema.agentSessions.id))
		.innerJoin(
			schema.issues,
			and(
				eq(schema.issueFileClaims.issueId, schema.issues.id),
				eq(schema.issues.workspaceId, ctx.workspaceId)
			)
		)
		.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.where(and(...conditions))
		.orderBy(schema.issueFileClaims.claimedAt);

	const items = rows.map(({ projectKey, issueNumber, live, ...claim }) => ({
		...claim,
		issueRef: `${projectKey}-${issueNumber}`,
		live: Boolean(live),
	}));

	return { items };
}

// PROJ-334: "abandoned claim" for the factory-health tile — released because the
// agent's session ended, not because the work was released deliberately.
//
// PROJ-636: this is no longer the only abandonment path. A claim whose holder stopped
// heartbeating is reclaimed as `expired` by the next claim on the same path, so a crashed
// agent no longer deadlocks its paths. Agent-end remains the *eager* path — it frees the
// claim immediately rather than leaving it to the next claimant — and it is the one that
// records `agent_ended` for the health tile, which distinguishes a clean exit from a crash.
export async function releaseClaimsForAgent(ctx: ServiceCtx, agentId: string) {
	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);

	await orm
		.update(schema.issueFileClaims)
		.set({ releasedAt: now, releaseReason: "agent_ended" })
		.where(
			and(
				eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
				eq(schema.issueFileClaims.agentId, agentId),
				isNull(schema.issueFileClaims.releasedAt)
			)
		);
}

/**
 * Build (without executing) the UPDATE that releases every active file claim on an
 * issue when it moves to done/cancelled (PROJ-928), mirroring
 * buildReleaseLeaseForClosedIssueStatement — a closed issue shouldn't keep files claimed
 * against it. Distinct release_reason from releaseFiles' "released". Returned as a
 * statement so the caller (updateIssue) folds it into its single ctx.db.batch().
 */
export function buildReleaseClaimsForClosedIssueStatement(
	ctx: ServiceCtx,
	issueId: string
): D1PreparedStatement {
	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);
	return toD1Statement(
		ctx,
		orm
			.update(schema.issueFileClaims)
			.set({ releasedAt: now, releaseReason: "issue_closed" })
			.where(
				and(
					eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
					eq(schema.issueFileClaims.issueId, issueId),
					isNull(schema.issueFileClaims.releasedAt)
				)
			)
			.toSQL()
	);
}
