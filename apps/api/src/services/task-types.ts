import { drizzle, schema } from "@projektor/db";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { IdSchema } from "../schemas/common";
import { CreateTaskTypeSchema, UpdateTaskTypeSchema } from "../schemas/task-types";
import * as cache from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

const WS_META_TTL = 60;

function buildTaskTypeUpdateSet(data: z.infer<typeof UpdateTaskTypeSchema>): Record<string, unknown> {
	const setObj: Record<string, unknown> = {};
	if (data.name !== undefined) setObj.name = data.name;
	if ("color" in data) setObj.color = data.color ?? null;
	if ("icon" in data) setObj.icon = data.icon ?? null;
	if (data.position !== undefined) setObj.position = data.position;
	if (data.isDefault !== undefined) setObj.isDefault = data.isDefault ? 1 : 0;
	return setObj;
}

export async function listTaskTypes(ctx: ServiceCtx) {
	const cacheKey = `ws-meta:${ctx.workspaceId}:task-types`;
	const cached = await cache.get<unknown[]>(ctx.kv, cacheKey);
	if (cached) return cached;

	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select()
		.from(schema.taskTypes)
		.where(eq(schema.taskTypes.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.taskTypes.position), asc(schema.taskTypes.name));
	const result = rows.map(({ isDefault, workspaceId, ...rest }) => ({
		...rest,
		workspace_id: workspaceId,
		is_default: isDefault,
	}));

	await cache.set(ctx.kv, cacheKey, result, WS_META_TTL);
	return result;
}

export async function createTaskType(ctx: ServiceCtx, raw: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const result = CreateTaskTypeSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { key, name, color, icon, position, isDefault } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.taskTypes.id })
		.from(schema.taskTypes)
		.where(and(eq(schema.taskTypes.workspaceId, ctx.workspaceId), eq(schema.taskTypes.key, key)))
		.get();
	if (existing) throw new ConflictError(`Task type key '${key}' already exists`);

	if (isDefault) {
		await orm
			.update(schema.taskTypes)
			.set({ isDefault: 0 })
			.where(eq(schema.taskTypes.workspaceId, ctx.workspaceId));
	}

	const id = crypto.randomUUID();
	await orm.insert(schema.taskTypes).values({
		id,
		workspaceId: ctx.workspaceId,
		key,
		name,
		color: color ?? null,
		icon: icon ?? null,
		position: position ?? 0,
		isDefault: isDefault ? 1 : 0,
	});

	return { id, key, name };
}

export async function updateTaskType(ctx: ServiceCtx, id: string, raw: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const result = UpdateTaskTypeSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const data = result.data;
	const setObj = buildTaskTypeUpdateSet(data);

	const orm = drizzle(ctx.db, { schema });

	if (data.isDefault) {
		await orm
			.update(schema.taskTypes)
			.set({ isDefault: 0 })
			.where(eq(schema.taskTypes.workspaceId, ctx.workspaceId));
	}

	const existing = await orm
		.select({ id: schema.taskTypes.id })
		.from(schema.taskTypes)
		.where(and(eq(schema.taskTypes.id, id), eq(schema.taskTypes.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Task type not found");

	await orm
		.update(schema.taskTypes)
		.set(setObj)
		.where(and(eq(schema.taskTypes.id, id), eq(schema.taskTypes.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function deleteTaskType(ctx: ServiceCtx, id: string) {
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();

	const orm = drizzle(ctx.db, { schema });
	const inUse = await orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.where(and(eq(schema.issues.typeId, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (inUse) throw new ConflictError("Task type is in use by one or more issues");

	const existing = await orm
		.select({ id: schema.taskTypes.id })
		.from(schema.taskTypes)
		.where(and(eq(schema.taskTypes.id, id), eq(schema.taskTypes.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Task type not found");

	await orm
		.delete(schema.taskTypes)
		.where(and(eq(schema.taskTypes.id, id), eq(schema.taskTypes.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function seedDefaultTaskTypes(db: D1Database, workspaceId: string) {
	const defaults = [
		{ key: "epic", name: "Epic", position: 1, isDefault: 0 },
		{ key: "story", name: "Story", position: 2, isDefault: 0 },
		{ key: "task", name: "Task", position: 3, isDefault: 1 },
		{ key: "bug", name: "Bug", position: 4, isDefault: 0 },
	];
	const orm = drizzle(db, { schema });
	for (const t of defaults) {
		await orm
			.insert(schema.taskTypes)
			.values({
				id: crypto.randomUUID(),
				workspaceId,
				key: t.key,
				name: t.name,
				color: null,
				icon: null,
				position: t.position,
				isDefault: t.isDefault,
			})
			.onConflictDoNothing();
	}
}
