import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ClaimFilesSchema, ListFileClaimsSchema, ReleaseFilesSchema } from "../schemas/file-claims";
import { postMessage } from "./agent-messages";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

export async function claimFiles(ctx: ServiceCtx, raw: unknown) {
	const result = ClaimFilesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, agentId, paths, force } = result.data;

	const orm = drizzle(ctx.db, { schema });

	// Verify issue belongs to workspace
	const issue = await orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (!issue) throw new NotFoundError("Issue not found");

	// Verify agent session belongs to workspace (if provided)
	if (agentId) {
		const agent = await orm
			.select({ id: schema.agentSessions.id })
			.from(schema.agentSessions)
			.where(
				and(
					eq(schema.agentSessions.id, agentId),
					eq(schema.agentSessions.workspaceId, ctx.workspaceId)
				)
			)
			.get();
		if (!agent) throw new NotFoundError("Agent session not found");
	}

	// Pre-check all paths for active claims — all-or-nothing on conflict.
	// inChunks keeps each query under D1's 100-bound-parameter cap. See services/sql.ts.
	const activeClaims = await inChunks(paths, (chunk) =>
		orm
			.select()
			.from(schema.issueFileClaims)
			.where(
				and(
					eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
					inArray(schema.issueFileClaims.path, chunk),
					isNull(schema.issueFileClaims.releasedAt)
				)
			)
	);

	const claimsByPath = new Map(activeClaims.map((c) => [c.path, c]));

	// Fail fast if any conflict and force is false
	if (!force) {
		for (const path of paths) {
			const existing = claimsByPath.get(path);
			if (existing) {
				throw new ConflictError(
					`Path "${path}" is held by issue ${existing.issueId}${existing.agentId ? ` (agent ${existing.agentId})` : ""}`
				);
			}
		}
	}

	const now = Math.floor(Date.now() / 1000);
	const overridden: typeof activeClaims = [];

	// Release conflicting claims when force is true, then insert new ones
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
				.set({ releasedAt: now })
				.where(eq(schema.issueFileClaims.id, existing.id));
			overridden.push({ ...existing, releasedAt: now });
		}
	}

	// Insert new claims
	const created: (typeof schema.issueFileClaims.$inferSelect)[] = [];
	for (const path of paths) {
		const id = crypto.randomUUID();
		await orm.insert(schema.issueFileClaims).values({
			id,
			workspaceId: ctx.workspaceId,
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
			.set({ releasedAt: now })
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

	const items = await orm
		.select()
		.from(schema.issueFileClaims)
		.where(and(...conditions))
		.orderBy(schema.issueFileClaims.claimedAt);

	return { items };
}

export async function releaseClaimsForAgent(ctx: ServiceCtx, agentId: string) {
	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);

	await orm
		.update(schema.issueFileClaims)
		.set({ releasedAt: now })
		.where(
			and(
				eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
				eq(schema.issueFileClaims.agentId, agentId),
				isNull(schema.issueFileClaims.releasedAt)
			)
		);
}
