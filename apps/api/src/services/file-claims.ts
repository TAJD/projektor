import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ClaimFilesSchema, ListFileClaimsSchema, ReleaseFilesSchema } from "../schemas/file-claims";
import { visibleProjectPredicate } from "./access";
import { postMessage } from "./agent-messages";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

async function assertIssueInWorkspace(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	issueId: string
) {
	const issue = await orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, workspaceId)))
		.get();
	if (!issue) throw new NotFoundError("Issue not found");
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

// inChunks keeps each query under D1's 100-bound-parameter cap. See services/sql.ts.
async function loadActiveClaimsByPath(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	paths: string[]
) {
	const activeClaims = await inChunks(paths, (chunk) =>
		orm
			.select()
			.from(schema.issueFileClaims)
			.where(
				and(
					eq(schema.issueFileClaims.workspaceId, workspaceId),
					inArray(schema.issueFileClaims.path, chunk),
					isNull(schema.issueFileClaims.releasedAt)
				)
			)
	);
	return new Map(activeClaims.map((c) => [c.path, c]));
}

async function assertNoConflicts(
	orm: ReturnType<typeof drizzle>,
	params: {
		workspaceId: string;
		issueId: string;
		agentId: string | undefined;
		paths: string[];
		claimsByPath: Map<string, { issueId: string; agentId: string | null }>;
		now: number;
	}
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
			`Path "${firstConflict.path}" is held by issue ${firstConflict.issueId}${firstConflict.agentId ? ` (agent ${firstConflict.agentId})` : ""}`
		);
	}
}

async function overrideConflictingClaims(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	params: {
		workspaceId: string;
		issueId: string;
		agentId: string | undefined;
		paths: string[];
		claimsByPath: Map<string, typeof schema.issueFileClaims.$inferSelect>;
		now: number;
	}
) {
	const { workspaceId, issueId, agentId, paths, claimsByPath, now } = params;
	const overridden: (typeof schema.issueFileClaims.$inferSelect)[] = [];
	for (const path of paths) {
		const existing = claimsByPath.get(path);
		if (existing) {
			await postMessage(ctx, {
				scope: `issue:${issueId}`,
				agentId: agentId ?? undefined,
				body: `force-claimed "${path}", overriding issue ${existing.issueId}`,
			});
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
	return overridden;
}

async function insertClaims(
	orm: ReturnType<typeof drizzle>,
	params: {
		workspaceId: string;
		issueId: string;
		agentId: string | undefined;
		paths: string[];
		now: number;
	}
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

	await assertIssueInWorkspace(orm, ctx.workspaceId, issueId);
	if (agentId) {
		await assertAgentInWorkspace(orm, ctx.workspaceId, agentId);
	}

	// Pre-check all paths for active claims — all-or-nothing on conflict.
	const claimsByPath = await loadActiveClaimsByPath(orm, ctx.workspaceId, paths);

	const now = Math.floor(Date.now() / 1000);

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

	return { created, overridden };
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

	const items = await orm
		.select()
		.from(schema.issueFileClaims)
		.where(and(...conditions))
		.orderBy(schema.issueFileClaims.claimedAt);

	return { items };
}

// PROJ-334: "abandoned claim" for the factory-health tile — released because the
// agent's session ended, not because the work was released deliberately. There's no
// separate expiry sweep for file claims (unlike issue_leases), so agent-end is the
// only abandonment path today.
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
