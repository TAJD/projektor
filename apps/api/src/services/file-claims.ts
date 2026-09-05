import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ClaimFilesSchema, ListFileClaimsSchema, ReleaseFilesSchema } from "../schemas/file-claims";
import { visibleProjectPredicate } from "./access";
import { postMessage } from "./agent-messages";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
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

// PROJ-636: mirrors SESSION_TTL_SECONDS in services/issue-leases.ts, which in turn mirrors
// ACTIVE_TTL in services/agents.ts. Kept local for the same reason theirs are: agents.ts
// already imports releaseClaimsForAgent from here, so importing back would cycle.
const SESSION_TTL_SECONDS = 120;

const liveCutoff = () => Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;

type ActiveClaim = typeof schema.issueFileClaims.$inferSelect & { live: boolean };

// inChunks keeps each query under D1's 100-bound-parameter cap. See services/sql.ts.
async function loadActiveClaimsByPath(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	paths: string[],
	cutoff: number
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
				// so they are treated as live and stay reclaimable only via `force`. Inferring
				// staleness from claim age instead would reintroduce the TTL that this tier
				// deliberately does not have.
				live:
					claim.agentId === null ||
					(sessionStatus === "active" && (sessionHeartbeat ?? 0) > cutoff),
			},
		])
	);
}

/**
 * Release claims whose holding session stopped heartbeating, and drop them from the map so
 * every downstream step sees only genuinely-held paths.
 *
 * PROJ-636: this is the file-claim twin of `reclaimStaleLeaseOrThrow` in
 * services/issue-leases.ts. Before it, an agent that died without calling `end_agent` —
 * crash, OOM, killed terminal, closed worktree tab — held its paths forever, and for
 * spawned workers dying without a clean exit is the normal case rather than the exception.
 *
 * Deliberately does NOT write to `claim_conflicts`. That log feeds the heatmap's contention
 * mode, whose whole claim is that a repeatedly-contended path says something about how the
 * work was sliced. Superseding a dead agent's abandoned claim is not two live agents
 * colliding, and recording it as such would inflate the signal with fleet mortality.
 */
async function reclaimStaleClaims(
	orm: ReturnType<typeof drizzle>,
	claimsByPath: Map<string, ActiveClaim>,
	now: number
): Promise<ActiveClaim[]> {
	const stale = [...claimsByPath.values()].filter((c) => !c.live);
	for (const claim of stale) {
		await orm
			.update(schema.issueFileClaims)
			.set({ releasedAt: now, releaseReason: "expired" })
			.where(eq(schema.issueFileClaims.id, claim.id));
		claimsByPath.delete(claim.path);
	}
	return stale.map((c) => ({ ...c, releasedAt: now, releaseReason: "expired" }));
}

async function assertNoConflicts(
	orm: ReturnType<typeof drizzle>,
	params: Readonly<{
		workspaceId: string;
		issueId: string;
		agentId: string | undefined;
		paths: string[];
		claimsByPath: Map<string, { issueId: string; agentId: string | null }>;
		now: number;
	}>
) {
	const { workspaceId, issueId, agentId, paths, claimsByPath, now } = params;
	// Record every contended path (rejection is all-or-nothing, but each simultaneously
	// held path is its own contention signal for the heat map), then throw naming the first.
	let firstConflict: { path: string; issueId: string; agentId: string | null } | undefined;
	for (const path of paths) {
		const existing = claimsByPath.get(path);
		if (existing) {
			await orm.insert(schema.claimConflicts).values({
				id: crypto.randomUUID(),
				workspaceId,
				path,
				rejectedIssueId: issueId,
				rejectedAgentId: agentId ?? null,
				holdingIssueId: existing.issueId,
				holdingAgentId: existing.agentId,
				forced: 0,
				occurredAt: now,
			});
			if (!firstConflict) firstConflict = { path, ...existing };
		}
	}
	if (firstConflict) {
		throw new ConflictError(
			`Path "${firstConflict.path}" is held by issue ${firstConflict.issueId}` +
				`${firstConflict.agentId ? ` (agent ${firstConflict.agentId})` : ""}`
		);
	}
}

async function overrideConflictingClaims(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	params: Readonly<{
		workspaceId: string;
		issueId: string;
		agentId: string | undefined;
		paths: string[];
		claimsByPath: Map<string, typeof schema.issueFileClaims.$inferSelect>;
		now: number;
	}>
) {
	const { workspaceId, issueId, agentId, paths, claimsByPath, now } = params;
	const overridden: (typeof schema.issueFileClaims.$inferSelect)[] = [];
	const displacedPaths = new Map<string, string[]>();
	for (const path of paths) {
		const existing = claimsByPath.get(path);
		if (existing) {
			const list = displacedPaths.get(existing.issueId) ?? [];
			list.push(path);
			displacedPaths.set(existing.issueId, list);
			await orm
				.update(schema.issueFileClaims)
				.set({ releasedAt: now, releaseReason: "overridden" })
				.where(eq(schema.issueFileClaims.id, existing.id));
			await orm.insert(schema.claimConflicts).values({
				id: crypto.randomUUID(),
				workspaceId,
				path,
				rejectedIssueId: issueId,
				rejectedAgentId: agentId ?? null,
				holdingIssueId: existing.issueId,
				holdingAgentId: existing.agentId,
				forced: 1,
				occurredAt: now,
			});
			overridden.push({ ...existing, releasedAt: now, releaseReason: "overridden" });
		}
	}
	for (const [displacedIssueId, displacedIssuePaths] of displacedPaths) {
		const pathList = displacedIssuePaths.map((p) => `"${p}"`).join(", ");
		await postMessage(ctx, {
			scope: `issue:${issueId}`,
			agentId: agentId ?? undefined,
			body: `force-claimed ${pathList}, overriding issue ${displacedIssueId}`,
		});
		await postMessage(ctx, {
			scope: `issue:${displacedIssueId}`,
			agentId: agentId ?? undefined,
			body: `issue ${issueId} force-claimed ${pathList}, which this issue held`,
		});
	}
	return overridden;
}

async function insertClaims(
	orm: ReturnType<typeof drizzle>,
	params: Readonly<{
		workspaceId: string;
		issueId: string;
		agentId: string | undefined;
		paths: string[];
		now: number;
	}>
) {
	const { workspaceId, issueId, agentId, paths, now } = params;
	const created: (typeof schema.issueFileClaims.$inferSelect)[] = [];
	for (const path of paths) {
		const id = crypto.randomUUID();
		await orm.insert(schema.issueFileClaims).values({
			id,
			workspaceId,
			issueId,
			agentId: agentId ?? null,
			path,
			claimedAt: now,
			releasedAt: null,
		});
		const row = await orm
			.select()
			.from(schema.issueFileClaims)
			.where(eq(schema.issueFileClaims.id, id))
			.get();
		// biome-ignore lint/style/noNonNullAssertion: row was just inserted; SELECT immediately after guarantees it exists
		created.push(row!);
	}
	return created;
}

export async function claimFiles(ctx: ServiceCtx, raw: unknown) {
	const result = ClaimFilesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, agentId, paths, force } = result.data;

	const orm = drizzle(ctx.db, { schema });

	const projectId = await assertIssueInWorkspace(orm, ctx.workspaceId, issueId);
	if (agentId) {
		await assertAgentInWorkspace(orm, ctx.workspaceId, agentId);
	}

	// Pre-check all paths for active claims — all-or-nothing on conflict.
	const claimsByPath = await loadActiveClaimsByPath(orm, ctx.workspaceId, paths, liveCutoff());

	const now = Math.floor(Date.now() / 1000);

	// Before conflict evaluation, so a dead holder neither blocks the claim nor lands in
	// claim_conflicts. Removing them from the map is what keeps the two steps below
	// unchanged — they only ever see live holders.
	const reclaimed = await reclaimStaleClaims(orm, claimsByPath, now);

	if (!force) {
		await assertNoConflicts(orm, {
			workspaceId: ctx.workspaceId,
			issueId,
			agentId: agentId ?? undefined,
			paths,
			claimsByPath,
			now,
		});
	}

	// Release conflicting claims when force is true, then insert new ones
	const overridden = await overrideConflictingClaims(ctx, orm, {
		workspaceId: ctx.workspaceId,
		issueId,
		agentId: agentId ?? undefined,
		paths,
		claimsByPath,
		now,
	});

	const created = await insertClaims(orm, {
		workspaceId: ctx.workspaceId,
		issueId,
		agentId: agentId ?? undefined,
		paths,
		now,
	});

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
	const { paths, issueId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);

	// inChunks on every variable-length IN below keeps each query under D1's
	// 100-bound-parameter cap (paths and ids are caller-/row-scaled). See services/sql.ts.
	// Fetch the rows that will be released
	const toRelease = await inChunks(paths, (chunk) => {
		const conditions = [
			eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
			inArray(schema.issueFileClaims.path, chunk),
			isNull(schema.issueFileClaims.releasedAt),
		];
		if (issueId) {
			conditions.push(eq(schema.issueFileClaims.issueId, issueId));
		}
		return orm
			.select()
			.from(schema.issueFileClaims)
			.where(and(...conditions));
	});

	if (toRelease.length === 0) {
		return { released: [], count: 0 };
	}

	const releaseIds = toRelease.map((r) => r.id);

	await inChunks(releaseIds, async (chunk) => {
		await orm
			.update(schema.issueFileClaims)
			.set({ releasedAt: now, releaseReason: "released" })
			.where(
				and(
					eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
					inArray(schema.issueFileClaims.id, chunk),
					isNull(schema.issueFileClaims.releasedAt)
				)
			);
		return [];
	});

	const released = await inChunks(releaseIds, (chunk) =>
		orm.select().from(schema.issueFileClaims).where(inArray(schema.issueFileClaims.id, chunk))
	);

	// Stamp projectId on the broadcast. When issueId is provided there is exactly one
	// project; otherwise released rows may span projects, so fan out one event per project.
	if (issueId) {
		const projectId = await assertIssueInWorkspace(orm, ctx.workspaceId, issueId);
		await broadcastWorkspaceEvent(ctx, {
			type: "claims.released",
			projectId,
			data: { issueId, paths, count: released.length },
		});
	} else {
		const releasedByProject = await inChunks(releaseIds, (chunk) =>
			orm
				.select({ projectId: schema.issues.projectId, path: schema.issueFileClaims.path })
				.from(schema.issueFileClaims)
				.innerJoin(schema.issues, eq(schema.issueFileClaims.issueId, schema.issues.id))
				.where(inArray(schema.issueFileClaims.id, chunk))
		);
		const grouped = new Map<string, string[]>();
		for (const row of releasedByProject) {
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

export async function listFileClaims(ctx: ServiceCtx, raw: unknown) {
	const result = ListFileClaimsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, path } = result.data;

	const orm = drizzle(ctx.db, { schema });

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

	// PROJ-316: a non-admin member only sees claims on issues whose project they
	// can access; owner/admin (predicate undefined) see every claim.
	const vis = visibleProjectPredicate(
		ctx,
		sql`(SELECT i.project_id FROM issues i WHERE i.id = ${schema.issueFileClaims.issueId})`
	);
	if (vis) conditions.push(vis);

	// PROJ-636: carries `live` for the same reason listIssueLeases does — false means the
	// holder stopped heartbeating and the next claim on that path will reclaim it. Without
	// it a reclaimable claim is indistinguishable from a held one, which would make the
	// self-healing the docs now describe unobservable.
	const cutoff = liveCutoff();
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
			sessionStatus: schema.agentSessions.status,
			sessionHeartbeat: schema.agentSessions.lastHeartbeatAt,
		})
		.from(schema.issueFileClaims)
		.leftJoin(schema.agentSessions, eq(schema.issueFileClaims.agentId, schema.agentSessions.id))
		.where(and(...conditions))
		.orderBy(schema.issueFileClaims.claimedAt);

	const items = rows.map(({ sessionStatus, sessionHeartbeat, ...claim }) => ({
		...claim,
		live:
			claim.agentId === null || (sessionStatus === "active" && (sessionHeartbeat ?? 0) > cutoff),
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
