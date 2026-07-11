import { drizzle, schema } from "@projektor/db";
import { and, asc, eq } from "drizzle-orm";
import { IdSchema } from "../schemas/common";
import { CreateProjectSchema, UpdateProjectSchema } from "../schemas/projects";
import { effectiveProjectRole, isWorkspaceAdmin, visibleProjectPredicate } from "./access";
import { recordActivity } from "./activity";
import * as cache from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

const WS_META_TTL = 60;
const PROJECTS_CACHE_KEY = (workspaceId: string) => `ws-meta:${workspaceId}:projects`;

export async function listProjects(ctx: ServiceCtx) {
	const orm = drizzle(ctx.db, { schema });

	// PROJ-311: owner/admin see every project and share the workspace cache. A
	// non-admin sees only granted projects; that set is per-user and access can be
	// revoked at any time, so it is computed per-request (uncached) to keep the
	// "effective on next request" guarantee — no stale project can linger.
	const visible = visibleProjectPredicate(ctx, schema.projects.id);
	if (!visible) {
		const cacheKey = PROJECTS_CACHE_KEY(ctx.workspaceId);
		const cached = await cache.get<unknown[]>(ctx.kv, cacheKey);
		if (cached) return cached;
		const result = await orm
			.select()
			.from(schema.projects)
			.where(eq(schema.projects.workspaceId, ctx.workspaceId))
			.orderBy(asc(schema.projects.name));
		await cache.set(ctx.kv, cacheKey, result, WS_META_TTL);
		return result;
	}

	return orm
		.select()
		.from(schema.projects)
		.where(and(eq(schema.projects.workspaceId, ctx.workspaceId), visible))
		.orderBy(asc(schema.projects.name));
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
      -- PROJ-311: in each workspace the user sees all projects if owner/admin there,
      -- otherwise only projects their groups grant (indexed EXISTS).
      WHERE wm.role IN ('owner','admin')
         OR EXISTS (
              SELECT 1 FROM user_group_members ugm
              JOIN group_project_grants gpg ON gpg.group_id = ugm.group_id
              WHERE ugm.user_id = ? AND gpg.project_id = p.id)
      GROUP BY p.id, p.name, p.key, p.description, p.created_at, p.updated_at,
               w.id, w.name, w.slug
      ORDER BY w.slug, p.name`
		)
		.bind(userId, userId)
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

	// PROJ-311: default-deny — a non-admin without a grant 404s (existence hidden).
	if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, id)) === null) {
		throw new NotFoundError("Project not found");
	}
	return project;
}

export async function createProject(ctx: ServiceCtx, input: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();

	const parsed = CreateProjectSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const { name, key, description, agentWipLimit } = parsed.data;

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
		agentWipLimit: agentWipLimit ?? null,
		createdAt: now,
		updatedAt: now,
	});

	await recordActivity(ctx, { entityType: "project", entityId: id, action: "created" });
	await cache.invalidate(ctx.kv, PROJECTS_CACHE_KEY(ctx.workspaceId));
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
	if (parsed.data.agentWipLimit !== undefined) setObj.agentWipLimit = parsed.data.agentWipLimit;

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
	await cache.invalidate(ctx.kv, PROJECTS_CACHE_KEY(ctx.workspaceId));

	return { ok: true };
}

export async function deleteProject(ctx: ServiceCtx, id: string) {
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	if (ctx.role !== "owner") throw new ForbiddenError();

	const orm = drizzle(ctx.db, { schema });
	await orm
		.delete(schema.projects)
		.where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, ctx.workspaceId)));

	await recordActivity(ctx, { entityType: "project", entityId: id, action: "deleted" });
	await cache.invalidate(ctx.kv, PROJECTS_CACHE_KEY(ctx.workspaceId));
	return { ok: true };
}
