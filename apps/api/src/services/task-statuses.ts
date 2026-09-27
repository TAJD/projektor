import { drizzle, schema } from "@projektor/db";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { IdSchema } from "../schemas/common";
import { CreateTaskStatusSchema, UpdateTaskStatusSchema } from "../schemas/task-statuses";
import * as cache from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

const WS_META_TTL = 60;
const WS_META_LOCAL_TTL_MS = 5000;
const TASK_STATUSES_CACHE_KEY = (workspaceId: string) => `ws-meta:${workspaceId}:task-statuses`;
const localCache = cache.createLocalCache<unknown[]>(WS_META_LOCAL_TTL_MS);

export async function listTaskStatuses(ctx: ServiceCtx) {
	const cacheKey = TASK_STATUSES_CACHE_KEY(ctx.workspaceId);
	const local = localCache.get(cacheKey);
	if (local) return local;

	const cached = await cache.get<unknown[]>(ctx.kv, cacheKey);
	if (cached) {
		localCache.set(cacheKey, cached);
		return cached;
	}

	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select()
		.from(schema.taskStatuses)
		.where(eq(schema.taskStatuses.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.taskStatuses.position), asc(schema.taskStatuses.name));
	const result = rows.map(({ isDefault, isReviewStep, workspaceId, ...rest }) => ({
		...rest,
		workspace_id: workspaceId,
		is_default: isDefault,
		is_review_step: isReviewStep,
	}));

	await cache.set(ctx.kv, cacheKey, result, WS_META_TTL);
	localCache.set(cacheKey, result);
	return result;
}

async function invalidateTaskStatusesCache(ctx: ServiceCtx) {
	const cacheKey = TASK_STATUSES_CACHE_KEY(ctx.workspaceId);
	await cache.invalidate(ctx.kv, cacheKey);
	localCache.invalidate(cacheKey);
}

export async function createTaskStatus(ctx: ServiceCtx, raw: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const result = CreateTaskStatusSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { key, name, category, color, position, isDefault, isReviewStep } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.taskStatuses.id })
		.from(schema.taskStatuses)
		.where(
			and(eq(schema.taskStatuses.workspaceId, ctx.workspaceId), eq(schema.taskStatuses.key, key))
		)
		.get();
	if (existing) throw new ConflictError(`Task status key '${key}' already exists`);

	if (isDefault) {
		await orm
			.update(schema.taskStatuses)
			.set({ isDefault: 0 })
			.where(eq(schema.taskStatuses.workspaceId, ctx.workspaceId));
	}

	const id = crypto.randomUUID();
	await orm.insert(schema.taskStatuses).values({
		id,
		workspaceId: ctx.workspaceId,
		key,
		name,
		category,
		color: color ?? null,
		position: position ?? 0,
		isDefault: isDefault ? 1 : 0,
		isReviewStep: isReviewStep ? 1 : 0,
	});

	await invalidateTaskStatusesCache(ctx);
	return { id, key, name };
}

type TaskStatusUpdateData = z.infer<typeof UpdateTaskStatusSchema>;

function buildTaskStatusSetObj(data: TaskStatusUpdateData) {
	const setObj: Record<string, unknown> = {};
	if (data.name !== undefined) setObj.name = data.name;
	if (data.category !== undefined) setObj.category = data.category;
	if ("color" in data) setObj.color = data.color ?? null;
	if (data.position !== undefined) setObj.position = data.position;
	if (data.isDefault !== undefined) setObj.isDefault = data.isDefault ? 1 : 0;
	if (data.isReviewStep !== undefined) setObj.isReviewStep = data.isReviewStep ? 1 : 0;
	return setObj;
}

export async function updateTaskStatus(ctx: ServiceCtx, id: string, raw: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const result = UpdateTaskStatusSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const data = result.data;

	const setObj = buildTaskStatusSetObj(data);
	const orm = drizzle(ctx.db, { schema });

	if (data.isDefault) {
		await orm
			.update(schema.taskStatuses)
			.set({ isDefault: 0 })
			.where(eq(schema.taskStatuses.workspaceId, ctx.workspaceId));
	}

	const existing = await orm
		.select({ id: schema.taskStatuses.id, category: schema.taskStatuses.category })
		.from(schema.taskStatuses)
		.where(
			and(eq(schema.taskStatuses.id, id), eq(schema.taskStatuses.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!existing) throw new NotFoundError("Task status not found");

	// PROJ-849: a status's category can change after issues already reference it by
	// status_id — re-sync issues.status_category for every issue on this status in the
	// same batch as the status update, so the two never drift (open/backlog tile counts
	// and anything else reading status_category depend on it staying in sync).
	const categoryChanged = setObj.category !== undefined && setObj.category !== existing.category;

	const statusUpdate = orm
		.update(schema.taskStatuses)
		.set(setObj)
		.where(
			and(eq(schema.taskStatuses.id, id), eq(schema.taskStatuses.workspaceId, ctx.workspaceId))
		);

	if (categoryChanged) {
		const issuesResync = orm
			.update(schema.issues)
			.set({ statusCategory: setObj.category as string })
			.where(and(eq(schema.issues.statusId, id), eq(schema.issues.workspaceId, ctx.workspaceId)));
		await orm.batch([statusUpdate, issuesResync]);
	} else {
		await statusUpdate;
	}

	await invalidateTaskStatusesCache(ctx);
	return { ok: true };
}

export async function deleteTaskStatus(ctx: ServiceCtx, id: string) {
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();

	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ isDefault: schema.taskStatuses.isDefault })
		.from(schema.taskStatuses)
		.where(
			and(eq(schema.taskStatuses.id, id), eq(schema.taskStatuses.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!row) throw new NotFoundError("Task status not found");
	if (row.isDefault === 1) throw new ConflictError("Cannot delete the default task status");

	const inUse = await orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.where(and(eq(schema.issues.statusId, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (inUse) throw new ConflictError("Task status is in use by one or more issues");

	await orm
		.delete(schema.taskStatuses)
		.where(
			and(eq(schema.taskStatuses.id, id), eq(schema.taskStatuses.workspaceId, ctx.workspaceId))
		);

	await invalidateTaskStatusesCache(ctx);
	return { ok: true };
}

export async function seedDefaultTaskStatuses(db: D1Database, workspaceId: string) {
	const defaults = [
		{
			key: "backlog",
			name: "Backlog",
			category: "todo",
			position: 1,
			isDefault: 1,
			isReviewStep: 0,
		},
		{ key: "todo", name: "Todo", category: "todo", position: 2, isDefault: 0, isReviewStep: 0 },
		{
			key: "in_progress",
			name: "In Progress",
			category: "in_progress",
			position: 3,
			isDefault: 0,
			isReviewStep: 0,
		},
		{
			key: "in_review",
			name: "In Review",
			category: "in_progress",
			position: 4,
			isDefault: 0,
			isReviewStep: 1,
		},
		{ key: "done", name: "Done", category: "done", position: 5, isDefault: 0, isReviewStep: 0 },
		{
			key: "cancelled",
			name: "Cancelled",
			category: "cancelled",
			position: 6,
			isDefault: 0,
			isReviewStep: 0,
		},
	];
	const orm = drizzle(db, { schema });
	for (const s of defaults) {
		await orm
			.insert(schema.taskStatuses)
			.values({
				id: crypto.randomUUID(),
				workspaceId,
				key: s.key,
				name: s.name,
				category: s.category as "todo" | "in_progress" | "done" | "cancelled",
				color: null,
				position: s.position,
				isDefault: s.isDefault,
				isReviewStep: s.isReviewStep,
			})
			.onConflictDoNothing();
	}
}

// PROJ-870: also returns the resolved status's category, read from the same row lookup —
// the issue write paths previously re-queried task_statuses by id just to get it.
// category is null when no task_statuses row backs the result (legacy key / fallback).
// PROJ-749: isReviewStep is the status's explicit review-step flag (only the built-in
// "in_review" key counts when there is no backing row).
export async function resolveStatus(
	ctx: ServiceCtx,
	statusId: string | null | undefined,
	legacyStatus?: string
): Promise<{ id: string | null; key: string; category: string | null; isReviewStep: boolean }> {
	const orm = drizzle(ctx.db, { schema });
	const cols = {
		id: schema.taskStatuses.id,
		key: schema.taskStatuses.key,
		category: schema.taskStatuses.category,
		isReviewStep: schema.taskStatuses.isReviewStep,
	};
	type Row = { id: string; key: string; category: string | null; isReviewStep: number };
	const fromRow = (r: Row) => ({ ...r, isReviewStep: r.isReviewStep === 1 });
	// No task_statuses row backs the key: only the built-in "in_review" is a review step.
	const fromKey = (key: string) => ({
		id: null,
		key,
		category: null,
		isReviewStep: key === "in_review",
	});

	if (statusId === null) {
		return fromKey(legacyStatus || "backlog");
	}
	if (statusId) {
		const found = await orm
			.select(cols)
			.from(schema.taskStatuses)
			.where(
				and(
					eq(schema.taskStatuses.id, statusId),
					eq(schema.taskStatuses.workspaceId, ctx.workspaceId)
				)
			)
			.get();
		if (!found)
			throw new ValidationError({
				formErrors: ["Task status not found in this workspace"],
				fieldErrors: {},
			});
		return fromRow(found);
	}
	if (legacyStatus) {
		const found = await orm
			.select(cols)
			.from(schema.taskStatuses)
			.where(
				and(
					eq(schema.taskStatuses.workspaceId, ctx.workspaceId),
					eq(schema.taskStatuses.key, legacyStatus)
				)
			)
			.get();
		return found ? fromRow(found) : fromKey(legacyStatus);
	}
	const def = await orm
		.select(cols)
		.from(schema.taskStatuses)
		.where(
			and(
				eq(schema.taskStatuses.workspaceId, ctx.workspaceId),
				eq(schema.taskStatuses.isDefault, 1)
			)
		)
		.get();
	return def ? fromRow(def) : fromKey("backlog");
}
