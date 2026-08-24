import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { IdSchema } from "../schemas/common";
import { CreateProjectSchema, UpdateProjectSchema } from "../schemas/projects";
import { effectiveProjectRole, isWorkspaceAdmin, visibleProjectPredicate } from "./access";
import { recordActivity } from "./activity";
import * as cache from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

const WS_META_TTL = 60;
const PROJECTS_CACHE_KEY = (workspaceId: string) => `ws-meta:${workspaceId}:projects`;

export async function listProjects(ctx: ServiceCtx, opts: { includeArchived?: boolean } = {}) {
	const orm = drizzle(ctx.db, { schema });

	// PROJ-311: owner/admin share the cached workspace list; others get an uncached per-user set.
	const visible = visibleProjectPredicate(ctx, schema.projects.id);
	const includeArchived = opts.includeArchived ?? false;
	if (!visible) {
		if (includeArchived) {
			return orm
				.select()
				.from(schema.projects)
				.where(eq(schema.projects.workspaceId, ctx.workspaceId))
				.orderBy(asc(schema.projects.name));
		}
		const cacheKey = PROJECTS_CACHE_KEY(ctx.workspaceId);
		const cached = await cache.get<unknown[]>(ctx.kv, cacheKey);
		if (cached) return cached;
		const result = await orm
			.select()
			.from(schema.projects)
			.where(
				and(eq(schema.projects.workspaceId, ctx.workspaceId), isNull(schema.projects.archivedAt))
			)
			.orderBy(asc(schema.projects.name));
		await cache.set(ctx.kv, cacheKey, result, WS_META_TTL);
		return result;
	}

	const conditions = [eq(schema.projects.workspaceId, ctx.workspaceId), visible];
	if (!includeArchived) conditions.push(isNull(schema.projects.archivedAt));

	return orm
		.select()
		.from(schema.projects)
		.where(and(...conditions))
		.orderBy(asc(schema.projects.name));
}

export interface ProjectSummary {
	id: string;
	name: string;
	key: string;
	slug: string | null;
	description: string | null;
	workspace_id: string;
	workspace_name: string;
	workspace_slug: string;
	open_issue_count: number;
	archived_at: number | null;
	created_at: number;
	updated_at: number;
}

export async function listProjectsAcrossWorkspaces(
	userId: string,
	db: D1Database,
	includeArchived = false
): Promise<ProjectSummary[]> {
	const rows = await db
		.prepare(
			`SELECT
        p.id,
        p.name,
        p.key,
        p.slug,
        p.description,
        p.archived_at,
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
      WHERE (wm.role IN ('owner','admin')
         OR EXISTS (
              SELECT 1 FROM user_group_members ugm
              JOIN group_project_grants gpg ON gpg.group_id = ugm.group_id
              WHERE ugm.user_id = ? AND gpg.project_id = p.id))
        ${includeArchived ? "" : "AND p.archived_at IS NULL"}
      GROUP BY p.id, p.name, p.key, p.slug, p.description, p.archived_at, p.created_at, p.updated_at,
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

// PROJ-376: pretty project URLs (/projects/view/<slug>) resolve here instead of
// the UUID route. Same visibility rules as getProject.
export async function getProjectBySlug(ctx: ServiceCtx, slug: string) {
	const orm = drizzle(ctx.db, { schema });
	const project = await orm
		.select()
		.from(schema.projects)
		.where(and(eq(schema.projects.slug, slug), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!project) throw new NotFoundError("Project not found");

	if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, project.id)) === null) {
		throw new NotFoundError("Project not found");
	}
	return project;
}

function slugify(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	);
}

// Generates a workspace-unique slug from the project name, appending -2, -3, ...
// on collision. Bounded query count: at most one SELECT per candidate tried.
async function generateUniqueSlug(
	orm: ReturnType<typeof drizzle>,
	workspaceId: string,
	name: string
): Promise<string> {
	const base = slugify(name);
	let candidate = base;
	for (let n = 2; ; n++) {
		const existing = await orm
			.select({ id: schema.projects.id })
			.from(schema.projects)
			.where(and(eq(schema.projects.workspaceId, workspaceId), eq(schema.projects.slug, candidate)))
			.get();
		if (!existing) return candidate;
		candidate = `${base}-${n}`;
	}
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
	const slug = await generateUniqueSlug(orm, ctx.workspaceId, name);

	await orm.insert(schema.projects).values({
		id,
		workspaceId: ctx.workspaceId,
		name,
		key,
		slug,
		description: description ?? null,
		agentWipLimit: agentWipLimit ?? null,
		createdAt: now,
		updatedAt: now,
	});

	await recordActivity(ctx, { entityType: "project", entityId: id, action: "created" });
	await cache.invalidate(ctx.kv, PROJECTS_CACHE_KEY(ctx.workspaceId));
	return { id, name, key, slug };
}

export async function updateProject(ctx: ServiceCtx, id: string, input: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();

	const parsed = UpdateProjectSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const now = Math.floor(Date.now() / 1000);

	const setObj: Record<string, unknown> = {};
	if (parsed.data.name !== undefined) setObj.name = parsed.data.name;
	if (parsed.data.key !== undefined) setObj.key = parsed.data.key;
	if (parsed.data.description !== undefined) setObj.description = parsed.data.description;
	if (parsed.data.agentWipLimit !== undefined) setObj.agentWipLimit = parsed.data.agentWipLimit;
	if (parsed.data.archived !== undefined) setObj.archivedAt = parsed.data.archived ? now : null;

	if (Object.keys(setObj).length === 0)
		throw new ValidationError({ formErrors: ["Nothing to update"], fieldErrors: {} });

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
