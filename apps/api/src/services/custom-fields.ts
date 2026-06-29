import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { CreateCustomFieldDefSchema, UpdateCustomFieldDefSchema } from "../schemas/custom-fields";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

export interface CustomFieldDef {
	id: string;
	workspace_id: string;
	project_id: string | null;
	key: string;
	label: string;
	type: string;
	options: string | null;
	created_at: number;
}

export interface CustomFieldValue {
	key: string;
	label: string;
	type: string;
	value: string;
}

export async function listCustomFieldDefs(ctx: ServiceCtx, projectId?: string | null) {
	const orm = drizzle(ctx.db, { schema });
	const conditions = [eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId)];

	if (projectId !== undefined) {
		conditions.push(
			projectId !== null
				? // biome-ignore lint/style/noNonNullAssertion: or() with two args never returns undefined
					or(
						isNull(schema.customFieldDefinitions.projectId),
						eq(schema.customFieldDefinitions.projectId, projectId)
					)!
				: isNull(schema.customFieldDefinitions.projectId)
		);
	}

	const rows = await orm
		.select()
		.from(schema.customFieldDefinitions)
		.where(and(...conditions))
		.orderBy(asc(schema.customFieldDefinitions.createdAt));
	return rows.map((d) => ({
		...d,
		options: d.options ? (JSON.parse(d.options) as string[]) : null,
	}));
}

export async function createCustomFieldDef(ctx: ServiceCtx, raw: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const result = CreateCustomFieldDefSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { key, label, type, options, projectId } = result.data;

	if (type !== "select" && options && options.length > 0) {
		throw new ValidationError({
			formErrors: ["options can only be set for select fields"],
			fieldErrors: {},
		});
	}

	const orm = drizzle(ctx.db, { schema });
	const projCondition = projectId
		? eq(schema.customFieldDefinitions.projectId, projectId)
		: isNull(schema.customFieldDefinitions.projectId);

	const existing = await orm
		.select({ id: schema.customFieldDefinitions.id })
		.from(schema.customFieldDefinitions)
		.where(
			and(
				eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId),
				projCondition,
				eq(schema.customFieldDefinitions.key, key)
			)
		)
		.get();
	if (existing) throw new ConflictError(`Custom field key '${key}' already exists`);

	const countRow = await orm
		.select({ n: sql<number>`count(*)` })
		.from(schema.customFieldDefinitions)
		.where(eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId))
		.get();
	if ((countRow?.n ?? 0) >= 50) {
		throw new ValidationError({
			formErrors: ["Maximum of 50 custom field definitions per workspace"],
			fieldErrors: {},
		});
	}

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await orm.insert(schema.customFieldDefinitions).values({
		id,
		workspaceId: ctx.workspaceId,
		projectId: projectId ?? null,
		key,
		label,
		type,
		options: options && options.length > 0 ? JSON.stringify(options) : null,
		createdAt: now,
	});

	return { id, key, label, type };
}

export async function updateCustomFieldDef(ctx: ServiceCtx, id: string, raw: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const result = UpdateCustomFieldDefSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const data = result.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.customFieldDefinitions.id, type: schema.customFieldDefinitions.type })
		.from(schema.customFieldDefinitions)
		.where(
			and(
				eq(schema.customFieldDefinitions.id, id),
				eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!existing) throw new NotFoundError("Custom field not found");

	if ("options" in data && data.options !== undefined && existing.type !== "select") {
		throw new ValidationError({
			formErrors: ["options can only be set for select fields"],
			fieldErrors: {},
		});
	}

	const setObj: Record<string, unknown> = {};
	if (data.label !== undefined) setObj.label = data.label;
	if ("options" in data) {
		setObj.options = data.options && data.options.length > 0 ? JSON.stringify(data.options) : null;
	}

	if (Object.keys(setObj).length === 0)
		throw new ValidationError({ formErrors: ["Nothing to update"], fieldErrors: {} });

	await orm
		.update(schema.customFieldDefinitions)
		.set(setObj)
		.where(
			and(
				eq(schema.customFieldDefinitions.id, id),
				eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

export async function deleteCustomFieldDef(ctx: ServiceCtx, id: string) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.customFieldDefinitions.id })
		.from(schema.customFieldDefinitions)
		.where(
			and(
				eq(schema.customFieldDefinitions.id, id),
				eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!existing) throw new NotFoundError("Custom field not found");

	const inUse = await orm
		.select({ issueId: schema.customFieldValues.issueId })
		.from(schema.customFieldValues)
		.where(eq(schema.customFieldValues.fieldId, id))
		.get();
	if (inUse) throw new ConflictError("Custom field is in use by one or more issues");

	await orm
		.delete(schema.customFieldDefinitions)
		.where(
			and(
				eq(schema.customFieldDefinitions.id, id),
				eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

export async function seedDefaultCustomFields(db: D1Database, workspaceId: string) {
	const orm = drizzle(db, { schema });
	const existing = await orm
		.select({ id: schema.customFieldDefinitions.id })
		.from(schema.customFieldDefinitions)
		.where(
			and(
				eq(schema.customFieldDefinitions.workspaceId, workspaceId),
				eq(schema.customFieldDefinitions.key, "story_points"),
				isNull(schema.customFieldDefinitions.projectId)
			)
		)
		.get();
	if (existing) return;

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await orm
		.insert(schema.customFieldDefinitions)
		.values({
			id,
			workspaceId,
			projectId: null,
			key: "story_points",
			label: "Story Points",
			type: "number",
			options: null,
			createdAt: now,
		})
		.onConflictDoNothing();
}

export async function validateCustomFields(
	db: D1Database,
	workspaceId: string,
	customFields: Record<string, unknown>
): Promise<Array<{ fieldId: string; value: string }>> {
	if (Object.keys(customFields).length === 0) return [];

	const orm = drizzle(db, { schema });
	const defs = await orm
		.select()
		.from(schema.customFieldDefinitions)
		.where(eq(schema.customFieldDefinitions.workspaceId, workspaceId));

	const defsByKey = new Map(defs.map((d) => [d.key, d]));
	const writes: Array<{ fieldId: string; value: string }> = [];

	for (const [key, rawValue] of Object.entries(customFields)) {
		const def = defsByKey.get(key);
		if (!def) {
			throw new ValidationError({
				formErrors: [],
				fieldErrors: { [key]: [`Unknown custom field key: ${key}`] },
			});
		}

		if (rawValue === null || rawValue === undefined || rawValue === "") {
			continue;
		}

		const value = String(rawValue);

		if (def.type === "number") {
			if (Number.isNaN(parseFloat(value)) || !Number.isFinite(parseFloat(value))) {
				throw new ValidationError({
					formErrors: [],
					fieldErrors: { [key]: [`Custom field '${key}' expects a number`] },
				});
			}
		} else if (def.type === "select") {
			const options: string[] = def.options ? (JSON.parse(def.options) as string[]) : [];
			if (!options.includes(value)) {
				throw new ValidationError({
					formErrors: [],
					fieldErrors: { [key]: [`Value '${value}' is not a valid option for field '${key}'`] },
				});
			}
		} else if (def.type === "date") {
			const d = new Date(value);
			if (Number.isNaN(d.getTime())) {
				throw new ValidationError({
					formErrors: [],
					fieldErrors: { [key]: [`Custom field '${key}' expects a valid date`] },
				});
			}
		}

		writes.push({ fieldId: def.id, value });
	}

	return writes;
}

export async function writeCustomFieldValues(
	db: D1Database,
	issueId: string,
	writes: Array<{ fieldId: string; value: string }>
) {
	const orm = drizzle(db, { schema });
	for (const { fieldId, value } of writes) {
		await orm
			.insert(schema.customFieldValues)
			.values({ issueId, fieldId, value })
			.onConflictDoUpdate({
				target: [schema.customFieldValues.issueId, schema.customFieldValues.fieldId],
				set: { value: sql`excluded.value` },
			});
	}
}

export async function batchLoadCustomFields(
	db: D1Database,
	workspaceId: string,
	issueIds: string[]
): Promise<Record<string, CustomFieldValue[]>> {
	if (issueIds.length === 0) return {};

	const orm = drizzle(db, { schema });

	// inChunks keeps each query under D1's 100-bound-parameter cap (one param per issue id
	// plus the workspaceId predicate). See services/sql.ts.
	const rows = await inChunks(issueIds, (chunk) =>
		// PROJ-197: scope by the field definition's workspace. Custom field definitions are
		// workspace-owned, so this confines results to the caller's workspace even if a
		// cross-workspace issueId is ever passed in — values whose definition lives in another
		// workspace are filtered out rather than leaked.
		orm
			.select({
				issueId: schema.customFieldValues.issueId,
				key: schema.customFieldDefinitions.key,
				label: schema.customFieldDefinitions.label,
				type: schema.customFieldDefinitions.type,
				value: schema.customFieldValues.value,
			})
			.from(schema.customFieldValues)
			.innerJoin(
				schema.customFieldDefinitions,
				eq(schema.customFieldDefinitions.id, schema.customFieldValues.fieldId)
			)
			.where(
				and(
					inArray(schema.customFieldValues.issueId, chunk),
					eq(schema.customFieldDefinitions.workspaceId, workspaceId)
				)
			)
	);

	const byIssue: Record<string, CustomFieldValue[]> = {};
	for (const r of rows) {
		if (!byIssue[r.issueId]) byIssue[r.issueId] = [];
		byIssue[r.issueId].push({ key: r.key, label: r.label, type: r.type, value: r.value });
	}
	return byIssue;
}
