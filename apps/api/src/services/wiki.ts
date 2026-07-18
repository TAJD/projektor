import { drizzle, schema } from "@projektor/db";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { wikiPagePath } from "../lib/urls";
import { IdSchema } from "../schemas/common";
import {
	CreatePageSchema,
	ListPagesInputSchema,
	SearchWikiInputSchema,
	UpdatePageSchema,
} from "../schemas/wiki";
import {
	canWriteProject,
	effectiveProjectRole,
	isWorkspaceAdmin,
	requireProjectInWorkspace,
	visibleProjectPredicate,
	visibleProjectSqlFragment,
} from "./access";
import { recordActivity } from "./activity";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

type TreeNode = { id: string; slug: string; title: string; url: string; children: TreeNode[] };

// PROJ-311: a wiki page is either workspace-level (projectId null — every member
// sees it) or project-scoped (visible only when the project is granted). Writes to
// a project-scoped page need a member/admin grant; deletes need admin.
async function assertWikiPageVisible(ctx: ServiceCtx, projectId: string | null): Promise<void> {
	if (projectId === null || isWorkspaceAdmin(ctx.role)) return;
	if ((await effectiveProjectRole(ctx, projectId)) === null) {
		throw new NotFoundError("Wiki page not found");
	}
}

async function requireWikiWrite(ctx: ServiceCtx, projectId: string | null): Promise<void> {
	if (projectId === null) {
		if (ctx.role === "viewer") throw new ForbiddenError("Insufficient permissions");
		return;
	}
	// PROJ-389: confirm projectId belongs to this workspace BEFORE the admin-bypass
	// check below, so an owner/admin can't write into another workspace's project.
	await requireProjectInWorkspace(ctx, projectId);
	if (isWorkspaceAdmin(ctx.role)) return;
	const role = await effectiveProjectRole(ctx, projectId);
	if (role === null) throw new NotFoundError("Wiki page not found");
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

async function resolvePageByIdOrSlug(
	db: D1Database,
	idOrSlug: string,
	workspaceId: string
): Promise<{ id: string; slug: string; content: string; projectId: string | null }> {
	const orm = drizzle(db, { schema });
	const page = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			content: schema.wikiPages.content,
			projectId: schema.wikiPages.projectId,
		})
		.from(schema.wikiPages)
		.where(
			and(
				or(eq(schema.wikiPages.id, idOrSlug), eq(schema.wikiPages.slug, idOrSlug)),
				eq(schema.wikiPages.workspaceId, workspaceId)
			)
		)
		.get();
	if (!page) throw new NotFoundError("Wiki page not found");
	return page;
}

async function validateParentDepth(
	db: D1Database,
	parentId: string,
	workspaceId: string,
	forbidPageId?: string
): Promise<void> {
	if (forbidPageId && parentId === forbidPageId) {
		throw new ValidationError({ formErrors: ["A page cannot be its own parent"], fieldErrors: {} });
	}
	let depth = 0;
	let cur = parentId;
	const seen = new Set<string>([parentId]);
	for (;;) {
		const row = await db
			.prepare("SELECT parent_id FROM wiki_pages WHERE id = ? AND workspace_id = ?")
			.bind(cur, workspaceId)
			.first<{ parent_id: string | null }>();
		if (!row?.parent_id) break;
		const pid = row.parent_id;
		if (seen.has(pid)) break;
		seen.add(pid);
		if (forbidPageId && pid === forbidPageId) {
			throw new ValidationError({
				formErrors: ["Setting this parent would create a cycle in the page hierarchy"],
				fieldErrors: {},
			});
		}
		cur = pid;
		depth++;
		if (depth >= 4) {
			throw new ValidationError({
				formErrors: ["Maximum wiki nesting depth (5) exceeded"],
				fieldErrors: {},
			});
		}
	}
}

async function validateNewPageParent(
	db: D1Database,
	parentId: string,
	workspaceId: string,
	projectId: string | null | undefined
): Promise<void> {
	const orm = drizzle(db, { schema });
	const parentPage = await orm
		.select({ id: schema.wikiPages.id, projectId: schema.wikiPages.projectId })
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.id, parentId), eq(schema.wikiPages.workspaceId, workspaceId)))
		.get();
	if (!parentPage) {
		throw new ValidationError({
			formErrors: ["Parent page not found in this workspace"],
			fieldErrors: {},
		});
	}
	if ((projectId ?? null) !== (parentPage.projectId ?? null)) {
		throw new ValidationError({
			formErrors: ["Parent page must belong to the same project"],
			fieldErrors: {},
		});
	}
	await validateParentDepth(db, parentId, workspaceId);
}

async function validateUpdatedPageParent(
	db: D1Database,
	parentId: string,
	workspaceId: string,
	page: { id: string; projectId: string | null }
): Promise<void> {
	const orm = drizzle(db, { schema });
	const parentPage = await orm
		.select({ id: schema.wikiPages.id, projectId: schema.wikiPages.projectId })
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.id, parentId), eq(schema.wikiPages.workspaceId, workspaceId)))
		.get();
	if (!parentPage) {
		throw new ValidationError({
			formErrors: ["Parent page not found in this workspace"],
			fieldErrors: {},
		});
	}
	if ((page.projectId ?? null) !== (parentPage.projectId ?? null)) {
		throw new ValidationError({
			formErrors: ["Parent page must belong to the same project"],
			fieldErrors: {},
		});
	}
	await validateParentDepth(db, parentId, workspaceId, page.id);
}

function buildWikiPageUpdateSet(
	now: number,
	updatedById: string,
	fields: { title?: string; content?: string; parentId?: string | null }
): Record<string, unknown> {
	const setData: Record<string, unknown> = { updatedAt: now, updatedById };
	if (fields.title !== undefined) setData.title = fields.title;
	if (fields.content !== undefined) setData.content = fields.content;
	if (fields.parentId !== undefined) setData.parentId = fields.parentId;
	return setData;
}

function buildWikiPageUpdateDiff(fields: {
	title?: string;
	content?: string;
}): Record<string, unknown> {
	const diff: Record<string, unknown> = {};
	if (fields.title !== undefined) diff.title = fields.title;
	if (fields.content !== undefined) diff.content = fields.content;
	return diff;
}

export async function listWikiPages(ctx: ServiceCtx, input: unknown) {
	const parsed = ListPagesInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const conditions = [eq(schema.wikiPages.workspaceId, ctx.workspaceId)];
	if (parsed.data.parentId) {
		conditions.push(eq(schema.wikiPages.parentId, parsed.data.parentId));
	}
	if (parsed.data.projectId) {
		conditions.push(eq(schema.wikiPages.projectId, parsed.data.projectId));
	}
	// PROJ-311: hide project-scoped pages whose project the user isn't granted
	// (workspace-level pages, projectId null, stay visible to everyone).
	const visible = visibleProjectPredicate(ctx, schema.wikiPages.projectId);
	if (visible) {
		const cond = or(isNull(schema.wikiPages.projectId), visible);
		if (cond) conditions.push(cond);
	}

	const rows = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			// eslint-disable-next-line camelcase
			parent_id: schema.wikiPages.parentId,
			// eslint-disable-next-line camelcase
			project_id: schema.wikiPages.projectId,
			// eslint-disable-next-line camelcase
			updated_at: schema.wikiPages.updatedAt,
		})
		.from(schema.wikiPages)
		.where(and(...conditions))
		.orderBy(asc(schema.wikiPages.title));

	return rows.map((r) => ({ ...r, url: wikiPagePath(r.slug, r.project_id) }));
}

export async function searchWiki(ctx: ServiceCtx, input: unknown) {
	const parsed = SearchWikiInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { query, limit, projectId } = parsed.data;
	if (!query) return [];
	if (projectId) {
		// PROJ-311: searching a specific project the user can't see returns nothing.
		if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
			return [];
		}
		const { results } = await ctx.db
			.prepare(
				`SELECT id, slug, title, project_id, substr(content, 1, 250) as excerpt
         FROM wiki_pages
         WHERE workspace_id = ? AND project_id = ? AND (title LIKE ? OR content LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`
			)
			.bind(ctx.workspaceId, projectId, `%${query}%`, `%${query}%`, limit)
			.all();
		return results;
	}
	// PROJ-311: across the workspace, exclude project-scoped pages the user isn't granted.
	const visible = visibleProjectSqlFragment(ctx, "project_id");
	const visClause = visible ? ` AND (project_id IS NULL OR ${visible.sql})` : "";
	const { results } = await ctx.db
		.prepare(
			`SELECT id, slug, title, project_id, substr(content, 1, 250) as excerpt
       FROM wiki_pages
       WHERE workspace_id = ? AND (title LIKE ? OR content LIKE ?)${visClause}
       ORDER BY updated_at DESC LIMIT ?`
		)
		.bind(ctx.workspaceId, `%${query}%`, `%${query}%`, ...(visible ? visible.params : []), limit)
		.all();
	return results;
}

export async function getWikiPage(ctx: ServiceCtx, slugOrId: string) {
	const orm = drizzle(ctx.db, { schema });
	const page = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			content: schema.wikiPages.content,
			// eslint-disable-next-line camelcase
			parent_id: schema.wikiPages.parentId,
			// eslint-disable-next-line camelcase
			project_id: schema.wikiPages.projectId,
			// eslint-disable-next-line camelcase
			updated_at: schema.wikiPages.updatedAt,
		})
		.from(schema.wikiPages)
		.where(
			and(
				or(eq(schema.wikiPages.id, slugOrId), eq(schema.wikiPages.slug, slugOrId)),
				eq(schema.wikiPages.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!page) throw new NotFoundError("Wiki page not found");
	await assertWikiPageVisible(ctx, page.project_id);
	return { ...page, url: wikiPagePath(page.slug, page.project_id) };
}

export async function createWikiPage(ctx: ServiceCtx, input: unknown) {
	const parsed = CreatePageSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { title, content, parentId, projectId, slug: customSlug } = parsed.data;

	await requireWikiWrite(ctx, projectId ?? null);

	if (parentId) {
		await validateNewPageParent(ctx.db, parentId, ctx.workspaceId, projectId);
	}

	const orm = drizzle(ctx.db, { schema });
	const slug = customSlug ?? slugify(title);
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await orm.insert(schema.wikiPages).values({
		id,
		workspaceId: ctx.workspaceId,
		projectId: projectId ?? null,
		slug,
		title,
		content: content ?? "",
		parentId: parentId ?? null,
		createdById: ctx.userId,
		updatedById: ctx.userId,
		createdAt: now,
		updatedAt: now,
	});
	await recordActivity(ctx, { entityType: "wiki_page", entityId: id, action: "created" });
	return { id, slug, projectId: projectId ?? null, url: wikiPagePath(slug, projectId ?? null) };
}

export async function updateWikiPage(ctx: ServiceCtx, idOrSlug: string, input: unknown) {
	const parsed = UpdatePageSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { title, content, parentId } = parsed.data;
	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await requireWikiWrite(ctx, page.projectId);
	const now = Math.floor(Date.now() / 1000);
	const orm = drizzle(ctx.db, { schema });

	if (parentId !== undefined && parentId !== null) {
		await validateUpdatedPageParent(ctx.db, parentId, ctx.workspaceId, page);
	}

	if (content !== undefined) {
		await orm.insert(schema.wikiRevisions).values({
			id: crypto.randomUUID(),
			pageId: page.id,
			content: page.content,
			authorId: ctx.userId,
			createdAt: now,
		});
	}

	const setData = buildWikiPageUpdateSet(now, ctx.userId, { title, content, parentId });
	await orm
		.update(schema.wikiPages)
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle set() requires typed columns; setData is safe
		.set(setData as any)
		.where(eq(schema.wikiPages.id, page.id));

	await recordActivity(ctx, {
		entityType: "wiki_page",
		entityId: page.id,
		action: "updated",
		diff: buildWikiPageUpdateDiff({ title, content }),
	});

	return { ok: true, url: wikiPagePath(page.slug, page.projectId) };
}

export async function deleteWikiPage(ctx: ServiceCtx, slug: string) {
	const idCheck = IdSchema.safeParse(slug);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	const orm = drizzle(ctx.db, { schema });
	const page = await orm
		.select({ id: schema.wikiPages.id, projectId: schema.wikiPages.projectId })
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.slug, slug), eq(schema.wikiPages.workspaceId, ctx.workspaceId)))
		.get();
	if (!page) throw new NotFoundError("Wiki page not found");

	// PROJ-311: workspace-level pages need a workspace admin/owner; a project-scoped
	// page can also be deleted by someone with a project-admin grant.
	if (page.projectId === null) {
		if (ctx.role !== "admin" && ctx.role !== "owner")
			throw new ForbiddenError("Insufficient permissions");
	} else if (!isWorkspaceAdmin(ctx.role)) {
		if ((await effectiveProjectRole(ctx, page.projectId)) !== "admin")
			throw new ForbiddenError("Insufficient permissions");
	}

	// PROJ-407: mirror the migration's ON DELETE CASCADE at the app level too, since
	// D1 does not guarantee FK enforcement is on for every connection.
	await orm.delete(schema.attachments).where(eq(schema.attachments.linkedWikiPageId, page.id));
	await orm.delete(schema.wikiPages).where(eq(schema.wikiPages.id, page.id));
	await recordActivity(ctx, { entityType: "wiki_page", entityId: page.id, action: "deleted" });
	return { ok: true };
}

export async function getWikiTree(ctx: ServiceCtx, projectId?: string): Promise<TreeNode[]> {
	const orm = drizzle(ctx.db, { schema });
	const conditions = [eq(schema.wikiPages.workspaceId, ctx.workspaceId)];
	if (projectId) conditions.push(eq(schema.wikiPages.projectId, projectId));
	// PROJ-311: same visibility filter as listWikiPages.
	const visible = visibleProjectPredicate(ctx, schema.wikiPages.projectId);
	if (visible) {
		const cond = or(isNull(schema.wikiPages.projectId), visible);
		if (cond) conditions.push(cond);
	}
	const rows = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			parentId: schema.wikiPages.parentId,
			projectId: schema.wikiPages.projectId,
		})
		.from(schema.wikiPages)
		.where(and(...conditions))
		.orderBy(asc(schema.wikiPages.title));

	const map = new Map<string, TreeNode>();
	for (const p of rows) {
		map.set(p.id, {
			id: p.id,
			slug: p.slug,
			title: p.title,
			url: wikiPagePath(p.slug, p.projectId),
			children: [],
		});
	}

	const roots: TreeNode[] = [];
	for (const p of rows) {
		// biome-ignore lint/style/noNonNullAssertion: every row was inserted into map on the previous loop
		const node = map.get(p.id)!;
		if (p.parentId && map.has(p.parentId)) {
			map.get(p.parentId)?.children.push(node);
		} else {
			roots.push(node);
		}
	}

	return roots;
}

export async function listWikiRevisions(ctx: ServiceCtx, slug: string) {
	const orm = drizzle(ctx.db, { schema });
	const page = await orm
		.select({ id: schema.wikiPages.id, projectId: schema.wikiPages.projectId })
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.slug, slug), eq(schema.wikiPages.workspaceId, ctx.workspaceId)))
		.get();
	if (!page) throw new NotFoundError("Wiki page not found");
	await assertWikiPageVisible(ctx, page.projectId);

	return orm
		.select({
			id: schema.wikiRevisions.id,
			// eslint-disable-next-line camelcase
			author_id: schema.wikiRevisions.authorId,
			// eslint-disable-next-line camelcase
			created_at: schema.wikiRevisions.createdAt,
			// eslint-disable-next-line camelcase
			author_name: schema.users.name,
		})
		.from(schema.wikiRevisions)
		.leftJoin(schema.users, eq(schema.wikiRevisions.authorId, schema.users.id))
		.where(eq(schema.wikiRevisions.pageId, page.id))
		.orderBy(desc(schema.wikiRevisions.createdAt));
}

export async function getWikiRevision(ctx: ServiceCtx, slug: string, revisionId: string) {
	const orm = drizzle(ctx.db, { schema });
	const page = await orm
		.select({ id: schema.wikiPages.id, projectId: schema.wikiPages.projectId })
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.slug, slug), eq(schema.wikiPages.workspaceId, ctx.workspaceId)))
		.get();
	if (!page) throw new NotFoundError("Wiki page not found");
	await assertWikiPageVisible(ctx, page.projectId);

	const revision = await orm
		.select({
			id: schema.wikiRevisions.id,
			content: schema.wikiRevisions.content,
			// eslint-disable-next-line camelcase
			author_id: schema.wikiRevisions.authorId,
			// eslint-disable-next-line camelcase
			created_at: schema.wikiRevisions.createdAt,
		})
		.from(schema.wikiRevisions)
		.where(and(eq(schema.wikiRevisions.id, revisionId), eq(schema.wikiRevisions.pageId, page.id)))
		.get();
	if (!revision) throw new NotFoundError("Revision not found");

	return revision;
}
