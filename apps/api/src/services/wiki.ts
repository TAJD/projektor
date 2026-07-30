import { drizzle, schema } from "@projektor/db";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { wikiPagePath } from "../lib/urls";
import { IdSchema } from "../schemas/common";
import {
	CreatePageSchema,
	DeleteWikiPageOptionsSchema,
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
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
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

// PROJ-483: wiki_pages(workspace_id, slug) is unique — surface a structured
// ConflictError instead of letting the constraint throw a raw D1 error.
async function assertSlugAvailable(
	orm: ReturnType<typeof drizzle<typeof schema>>,
	workspaceId: string,
	slug: string,
	excludePageId?: string
): Promise<void> {
	const existing = await orm
		.select({ id: schema.wikiPages.id })
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.workspaceId, workspaceId), eq(schema.wikiPages.slug, slug)))
		.get();
	if (existing && existing.id !== excludePageId) {
		throw new ConflictError(`Slug '${slug}' is already in use`);
	}
}

async function resolvePageByIdOrSlug(
	db: D1Database,
	idOrSlug: string,
	workspaceId: string
): Promise<{ id: string; slug: string; content: string; projectId: string | null }> {
	const orm = drizzle(db, { schema });
	const direct = await orm
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
	if (direct) return direct;
	// PROJ-483: fall back to a redirect (old slug -> page id) so operations other
	// than getWikiPage also resolve a renamed page's previous slug rather than 404ing.
	const redirected = await resolveWikiPageByRedirect(orm, workspaceId, idOrSlug);
	if (redirected) {
		return {
			id: redirected.id,
			slug: redirected.slug,
			content: redirected.content,
			// eslint-disable-next-line camelcase
			projectId: redirected.project_id,
		};
	}
	throw new NotFoundError("Wiki page not found");
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
	fields: { title?: string; content?: string; parentId?: string | null; slug?: string }
): Record<string, unknown> {
	const setData: Record<string, unknown> = { updatedAt: now, updatedById };
	if (fields.title !== undefined) setData.title = fields.title;
	if (fields.content !== undefined) setData.content = fields.content;
	if (fields.parentId !== undefined) setData.parentId = fields.parentId;
	if (fields.slug !== undefined) setData.slug = fields.slug;
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

const wikiPageDetailColumns = {
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
};

// PROJ-483: a slug with no live page may still be a former slug of one — recorded in
// wiki_redirects when the page was renamed (updateWikiPage below). Redirects always
// point at the page's current id, so this is a single hop regardless of how many
// times the page has been renamed since.
async function resolveWikiPageByRedirect(
	orm: ReturnType<typeof drizzle<typeof schema>>,
	workspaceId: string,
	oldSlug: string
) {
	const redirect = await orm
		.select({ pageId: schema.wikiRedirects.pageId })
		.from(schema.wikiRedirects)
		.where(
			and(
				eq(schema.wikiRedirects.workspaceId, workspaceId),
				eq(schema.wikiRedirects.oldSlug, oldSlug)
			)
		)
		.get();
	if (!redirect) return undefined;
	return orm
		.select(wikiPageDetailColumns)
		.from(schema.wikiPages)
		.where(
			and(eq(schema.wikiPages.id, redirect.pageId), eq(schema.wikiPages.workspaceId, workspaceId))
		)
		.get();
}

export async function getWikiPage(ctx: ServiceCtx, slugOrId: string) {
	const orm = drizzle(ctx.db, { schema });
	const direct = await orm
		.select(wikiPageDetailColumns)
		.from(schema.wikiPages)
		.where(
			and(
				or(eq(schema.wikiPages.id, slugOrId), eq(schema.wikiPages.slug, slugOrId)),
				eq(schema.wikiPages.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	// PROJ-483: live page always wins over a redirect, so reusing an old slug for a
	// new/renamed page never leaves getWikiPage returning an ambiguous result.
	const page = direct ?? (await resolveWikiPageByRedirect(orm, ctx.workspaceId, slugOrId));
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
	await assertSlugAvailable(orm, ctx.workspaceId, slug);
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	try {
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
	} catch (e) {
		// PROJ-483: assertSlugAvailable-then-insert isn't atomic — a concurrent create
		// can win the race between the check and this insert. Surface the resulting
		// unique-index violation as a structured conflict, not a raw 500.
		if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
			throw new ConflictError(`Slug '${slug}' is already in use`);
		}
		throw e;
	}
	await recordActivity(ctx, { entityType: "wiki_page", entityId: id, action: "created" });
	return { id, slug, projectId: projectId ?? null, url: wikiPagePath(slug, projectId ?? null) };
}

export async function updateWikiPage(ctx: ServiceCtx, idOrSlug: string, input: unknown) {
	const parsed = UpdatePageSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { title, content, parentId, slug } = parsed.data;
	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await requireWikiWrite(ctx, page.projectId);
	const now = Math.floor(Date.now() / 1000);
	const orm = drizzle(ctx.db, { schema });

	if (parentId !== undefined && parentId !== null) {
		await validateUpdatedPageParent(ctx.db, parentId, ctx.workspaceId, page);
	}

	// PROJ-483: renaming the slug — check the new slug isn't already live, then leave a
	// redirect from the old slug to this page so existing links keep resolving.
	const isRename = slug !== undefined && slug !== page.slug;
	if (isRename) {
		await assertSlugAvailable(orm, ctx.workspaceId, slug, page.id);
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

	const setData = buildWikiPageUpdateSet(now, ctx.userId, { title, content, parentId, slug });
	try {
		await orm
			.update(schema.wikiPages)
			// biome-ignore lint/suspicious/noExplicitAny: Drizzle set() requires typed columns; setData is safe
			.set(setData as any)
			.where(eq(schema.wikiPages.id, page.id));
	} catch (e) {
		// PROJ-483: assertSlugAvailable-then-update isn't atomic — a concurrent rename
		// can win the race between the check and this update. Surface the resulting
		// unique-index violation as a structured conflict, not a raw 500.
		if (isRename && e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
			throw new ConflictError(`Slug '${slug}' is already in use`);
		}
		throw e;
	}

	if (isRename) {
		// Upsert: the old slug may already carry a stale redirect from an earlier rename
		// of some other page — this rename takes ownership of it.
		await orm
			.insert(schema.wikiRedirects)
			.values({
				id: crypto.randomUUID(),
				workspaceId: ctx.workspaceId,
				oldSlug: page.slug,
				pageId: page.id,
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: [schema.wikiRedirects.workspaceId, schema.wikiRedirects.oldSlug],
				set: { pageId: page.id, createdAt: now },
			});
	}

	await recordActivity(ctx, {
		entityType: "wiki_page",
		entityId: page.id,
		action: "updated",
		diff: buildWikiPageUpdateDiff({ title, content }),
	});

	return { ok: true, url: wikiPagePath(slug ?? page.slug, page.projectId) };
}

// PROJ-238: breadth-first walk of parent_id children, chunked to stay under D1's
// bound-parameter cap regardless of subtree size.
async function collectDescendantIds(
	db: D1Database,
	rootId: string,
	workspaceId: string
): Promise<string[]> {
	const orm = drizzle(db, { schema });
	const descendants: string[] = [];
	let frontier = [rootId];
	while (frontier.length > 0) {
		const children = await inChunks(frontier, (chunk) =>
			orm
				.select({ id: schema.wikiPages.id })
				.from(schema.wikiPages)
				.where(
					and(
						inArray(schema.wikiPages.parentId, chunk),
						eq(schema.wikiPages.workspaceId, workspaceId)
					)
				)
		);
		frontier = children.map((c) => c.id);
		descendants.push(...frontier);
	}
	return descendants;
}

// PROJ-426: file attachments uploaded directly to a wiki page (entityType="wiki_page",
// entityId=pageId) aren't covered by the FK cascade on linkedWikiPageId — that column is
// only set for wiki_ref pointer attachments elsewhere that link to this page. Delete the
// R2 objects before dropping the rows, mirroring mcp/files.ts's delete_attachment handler.
async function deleteWikiPageAttachments(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle<typeof schema>>,
	pageIds: string[]
): Promise<void> {
	const fileAttachments = await orm
		.select({ r2Key: schema.attachments.r2Key })
		.from(schema.attachments)
		.where(
			and(
				eq(schema.attachments.entityType, "wiki_page"),
				inArray(schema.attachments.entityId, pageIds),
				eq(schema.attachments.kind, "file")
			)
		);
	for (const { r2Key } of fileAttachments) {
		if (r2Key) await ctx.r2.delete(r2Key);
	}

	await orm
		.delete(schema.attachments)
		.where(
			and(
				eq(schema.attachments.entityType, "wiki_page"),
				inArray(schema.attachments.entityId, pageIds)
			)
		);

	// PROJ-407: mirror the migration's ON DELETE CASCADE at the app level too, since
	// D1 does not guarantee FK enforcement is on for every connection. wiki_ref pointer
	// rows have no R2 object (r2Key is "").
	await orm.delete(schema.attachments).where(inArray(schema.attachments.linkedWikiPageId, pageIds));
}

export async function deleteWikiPage(ctx: ServiceCtx, slug: string, options?: unknown) {
	const idCheck = IdSchema.safeParse(slug);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	const parsedOptions = DeleteWikiPageOptionsSchema.safeParse(options ?? {});
	if (!parsedOptions.success) throw new ValidationError(parsedOptions.error.flatten());
	const { cascade } = parsedOptions.data;

	const orm = drizzle(ctx.db, { schema });
	const page = await orm
		.select({
			id: schema.wikiPages.id,
			projectId: schema.wikiPages.projectId,
			parentId: schema.wikiPages.parentId,
		})
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

	if (cascade) {
		const descendantIds = await collectDescendantIds(ctx.db, page.id, ctx.workspaceId);
		const allIds = [page.id, ...descendantIds];
		await inChunks(allIds, async (chunk) => {
			await deleteWikiPageAttachments(ctx, orm, chunk);
			return [];
		});
		await inChunks(allIds, async (chunk) => {
			await orm.delete(schema.wikiPages).where(inArray(schema.wikiPages.id, chunk));
			return [];
		});
		await recordActivity(ctx, {
			entityType: "wiki_page",
			entityId: page.id,
			action: "deleted",
			diff: { cascade: true, deletedCount: allIds.length },
		});
		return { ok: true, deletedCount: allIds.length };
	}

	// PROJ-238: no FK constraint on parent_id, so a plain delete would otherwise leave
	// children pointing at a row that no longer exists. Default behavior is to promote
	// them to the deleted page's own parent (which may be null, i.e. the root).
	await orm
		.update(schema.wikiPages)
		.set({ parentId: page.parentId })
		.where(eq(schema.wikiPages.parentId, page.id));

	await deleteWikiPageAttachments(ctx, orm, [page.id]);
	await orm.delete(schema.wikiPages).where(eq(schema.wikiPages.id, page.id));
	await recordActivity(ctx, { entityType: "wiki_page", entityId: page.id, action: "deleted" });
	return { ok: true, deletedCount: 1 };
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
