import { drizzle, schema } from "@projektor/db";
import { and, asc, eq } from "drizzle-orm";
import { CreateProjectSchema, UpdateProjectSchema } from "../schemas/projects";
import { recordActivity } from "./activity";
import * as cache from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

const WS_META_TTL = 60;

export async function listProjects(ctx: ServiceCtx) {
	const cacheKey = `ws-meta:${ctx.workspaceId}:projects`;
	const cached = await cache.get<unknown[]>(ctx.kv, cacheKey);
	if (cached) return cached;

	const orm = drizzle(ctx.db, { schema });
	const result = await orm
		.select()
		.from(schema.projects)
		.where(eq(schema.projects.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.projects.name));

	await cache.set(ctx.kv, cacheKey, result, WS_META_TTL);
	return result;
}

export interface ProjectSummary {
	id: string;
	name: string;
	key: string;
	description: string | null;
	workspace_id: string;
	workspace_name: string;
	workspace_slug: string;
	open_issue_count: number;
	created_at: number;
	updated_at: number;
}

export async function listAllProjects(userId: string, db: D1Database): Promise<ProjectSummary[]> {
	const rows = await db
		.prepare(
			`SELECT
        p.id,
        p.name,
        p.key,
        p.description,
        p.created_at,
        p.updated_at,
        w.id   AS workspace_id,
        w.name AS workspace_name,
        w.slug AS workspace_slug,
        COUNT(CASE WHEN COALESCE(NULLIF(i.status_category, ''), i.status) NOT IN ('done','cancelled') THEN 1 END)
          AS open_issue_count
      FROM projects p
      JOIN workspaces w         ON w.id  = p.workspace_id
      JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
      LEFT JOIN issues i        ON i.project_id = p.id
      GROUP BY p.id, p.name, p.key, p.description, p.created_at, p.updated_at,
               w.id, w.name, w.slug
      ORDER BY w.slug, p.name`
		)
		.bind(userId)
		.all<ProjectSummary>();
	return rows.results;
}

export async function getProject(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const project = await orm
		.select()
		.from(schema.projects)
		.where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!project) throw new NotFoundError("Project not found");
	return project;
}

export async function createProject(ctx: ServiceCtx, input: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();

	const parsed = CreateProjectSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const { name, key, description } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.projects.id })
		.from(schema.projects)
		.where(and(eq(schema.projects.workspaceId, ctx.workspaceId), eq(schema.projects.key, key)))
		.get();
	if (existing) throw new ConflictError(`Project key ${key} already exists`);

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await orm.insert(schema.projects).values({
		id,
		workspaceId: ctx.workspaceId,
		name,
		key,
		description: description ?? null,
		createdAt: now,
		updatedAt: now,
	});

	await recordActivity(ctx, { entityType: "project", entityId: id, action: "created" });
	return { id, name, key };
}

export async function updateProject(ctx: ServiceCtx, id: string, input: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();

	const parsed = UpdateProjectSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const setObj: Record<string, unknown> = {};
	if (parsed.data.name !== undefined) setObj.name = parsed.data.name;
	if (parsed.data.key !== undefined) setObj.key = parsed.data.key;
	if (parsed.data.description !== undefined) setObj.description = parsed.data.description;

	if (Object.keys(setObj).length === 0)
		throw new ValidationError({ formErrors: ["Nothing to update"], fieldErrors: {} });

	const now = Math.floor(Date.now() / 1000);
	setObj.updatedAt = now;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.projects.id })
		.from(schema.projects)
		.where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Project not found");

	await orm
		.update(schema.projects)
		.set(setObj)
		.where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, ctx.workspaceId)));

	const diff: Record<string, unknown> = { ...setObj };
	delete diff.updatedAt;
	await recordActivity(ctx, { entityType: "project", entityId: id, action: "updated", diff });

	return { ok: true };
}

export async function deleteProject(ctx: ServiceCtx, id: string) {
	if (ctx.role !== "owner") throw new ForbiddenError();

	const orm = drizzle(ctx.db, { schema });
	await orm
		.delete(schema.projects)
		.where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, ctx.workspaceId)));

	await recordActivity(ctx, { entityType: "project", entityId: id, action: "deleted" });
	return { ok: true };
}
