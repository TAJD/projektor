import { drizzle, schema } from "@projektor/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { wikiPagePath } from "../lib/urls";
import { IdSchema } from "../schemas/common";
import {
	CreatePageSchema,
	DeleteWikiPageOptionsSchema,
	ListPagesInputSchema,
	ListStaleWikiPagesInputSchema,
	ListWikiTemplatesInputSchema,
	ListWikiTrashInputSchema,
	type PatchWikiPageInput,
	PatchWikiPageInputSchema,
	SearchWikiInputSchema,
	SlugSchema,
	UpdatePageSchema,
	WikiRevisionDiffInputSchema,
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
import { deleteWikiDraftsForPages } from "./wiki-drafts";
import { computeFreshness } from "./wiki-freshness";
import {
	parseWikiFrontmatter,
	stampWikiFrontmatterVerification,
	stripTemplateFlag,
	type WikiFrontmatterMeta,
} from "./wiki-frontmatter";
import {
	backlinksForResolvedPage,
	clearIncomingLinkTargets,
	countBacklinkSources,
	deleteWikiLinksForPages,
	reindexWikiLinks,
	type WikiBacklink,
} from "./wiki-links";
import {
	deleteWikiWatchersForPages,
	notifyCascadeDescendantWatchers,
	notifyWikiWatchers,
} from "./wiki-watchers";

type TreeNode = {
	id: string;
	slug: string;
	title: string;
	url: string;
	type: string | null;
	children: TreeNode[];
};

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

// PROJ-487: "view" is the shell path segment the Worker's pretty-URL fallback serves
// static assets from (/wiki/view/index.html) — a page slugged "view" would collide
// with it and never resolve. "index" collides the same way: Static Assets' default
// html_handling maps /wiki/index -> /wiki/index.html, so it never reaches the Worker
// either. Both reserved outright rather than special-cased in routing.
//
// PROJ-491: "templates" collides the same way at the API layer — GET /api/wiki/templates
// is the template-picker endpoint (routes/wiki.ts), registered before the /:slug
// catch-all, so a page slugged "templates" would be shadowed by it and never load. The
// seeded Templates parent page therefore uses "page-templates" (seedDefaultWikiTemplates
// / migration 0047).
const RESERVED_WIKI_SLUGS = new Set(["view", "index", "templates"]);

// PROJ-496 (R14): 30-day trash retention — purgeExpiredWikiPages permanently removes a
// page (and its R2 attachments) once it's been soft-deleted for at least this long.
const WIKI_TRASH_RETENTION_SECONDS = 30 * 24 * 60 * 60;

// PROJ-483: wiki_pages(workspace_id, slug) is unique among LIVE pages — surface a
// structured ConflictError instead of letting the constraint throw a raw D1 error.
// PROJ-496: the underlying unique index is now PARTIAL (`WHERE deleted_at IS NULL`,
// 0051_wiki_trash.sql) so a trashed page's slug is immediately available again — this
// check mirrors that by only considering live rows.
async function assertSlugAvailable(
	orm: ReturnType<typeof drizzle<typeof schema>>,
	workspaceId: string,
	slug: string,
	excludePageId?: string
): Promise<void> {
	if (RESERVED_WIKI_SLUGS.has(slug)) {
		throw new ValidationError({
			formErrors: [`Slug '${slug}' is reserved and cannot be used`],
			fieldErrors: {},
		});
	}
	const existing = await orm
		.select({ id: schema.wikiPages.id })
		.from(schema.wikiPages)
		.where(
			and(
				eq(schema.wikiPages.workspaceId, workspaceId),
				eq(schema.wikiPages.slug, slug),
				isNull(schema.wikiPages.deletedAt)
			)
		)
		.get();
	if (existing && existing.id !== excludePageId) {
		throw new ConflictError(`Slug '${slug}' is already in use`);
	}
}

async function resolvePageByIdOrSlug(
	db: D1Database,
	idOrSlug: string,
	workspaceId: string
): Promise<{
	id: string;
	slug: string;
	title: string;
	content: string;
	projectId: string | null;
	parentId: string | null;
	isTemplate: boolean;
}> {
	const orm = drizzle(db, { schema });
	const direct = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			content: schema.wikiPages.content,
			projectId: schema.wikiPages.projectId,
			parentId: schema.wikiPages.parentId,
			isTemplate: schema.wikiPages.isTemplate,
		})
		.from(schema.wikiPages)
		.where(
			and(
				or(eq(schema.wikiPages.id, idOrSlug), eq(schema.wikiPages.slug, idOrSlug)),
				eq(schema.wikiPages.workspaceId, workspaceId),
				// PROJ-496: a trashed page is treated as gone for every normal read/write
				// entry point — only undeleteWikiPage/listWikiTrash bypass this filter.
				isNull(schema.wikiPages.deletedAt)
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
			title: redirected.title,
			content: redirected.content,
			// eslint-disable-next-line camelcase
			projectId: redirected.project_id,
			// eslint-disable-next-line camelcase
			parentId: redirected.parent_id,
			// eslint-disable-next-line camelcase
			isTemplate: redirected.is_template,
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
		.where(
			and(
				eq(schema.wikiPages.id, parentId),
				eq(schema.wikiPages.workspaceId, workspaceId),
				// PROJ-496: a page can't be (re)parented under a trashed page.
				isNull(schema.wikiPages.deletedAt)
			)
		)
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
		.where(
			and(
				eq(schema.wikiPages.id, parentId),
				eq(schema.wikiPages.workspaceId, workspaceId),
				// PROJ-496: a page can't be (re)parented under a trashed page.
				isNull(schema.wikiPages.deletedAt)
			)
		)
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
	fields: {
		title?: string;
		content?: string;
		parentId?: string | null;
		slug?: string;
		meta?: WikiFrontmatterMeta;
	}
): Record<string, unknown> {
	const setData: Record<string, unknown> = { updatedAt: now, updatedById };
	if (fields.title !== undefined) setData.title = fields.title;
	if (fields.content !== undefined) setData.content = fields.content;
	if (fields.parentId !== undefined) setData.parentId = fields.parentId;
	if (fields.slug !== undefined) setData.slug = fields.slug;
	// PROJ-488: only reparsed (and only overwritten) when content changes — a
	// title/parent/slug-only update leaves the page's existing frontmatter metadata as-is.
	if (fields.meta !== undefined) {
		setData.type = fields.meta.type;
		setData.tags = fields.meta.tags;
		setData.status = fields.meta.status;
		setData.verifiedAt = fields.meta.verifiedAt;
		setData.verifiedBy = fields.meta.verifiedBy;
		setData.owners = fields.meta.owners;
		setData.verifyInterval = fields.meta.verifyInterval;
		setData.isTemplate = fields.meta.isTemplate;
	}
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

// PROJ-488: any-of tag match — a page matches if `wiki_pages.tags` (a JSON array
// column) contains at least one of the given tags. json_each is the standard SQLite
// way to query into a JSON array column without denormalizing it into its own table;
// `tags` has no direct index (see 0045_wiki_frontmatter.sql), so this is a per-row
// scan, acceptable at current wiki sizes — revisit with a join table if it becomes hot.
function tagsFilterCondition(tags: string[]) {
	if (tags.length === 0) return undefined;
	return sql`EXISTS (SELECT 1 FROM json_each(${schema.wikiPages.tags}) WHERE value IN (${sql.join(
		tags.map((t) => sql`${t}`),
		sql`, `
	)}))`;
}

// PROJ-489 (R7): a page is "stale" for maintenance-queue/ranking-demotion purposes when
// EITHER an explicit `status: stale|deprecated` is set, OR a `verify_interval` was
// declared and the page is either never-verified or overdue. This is the SQL-side
// mirror of computeFreshness's stale/unverified branches (services/wiki-freshness.ts) —
// kept in lockstep by hand since this needs to run inside SQL (ORDER BY / WHERE) rather
// than per-row in JS. `now` is passed in as a bound parameter (not `strftime('%s','now')`)
// so ranking and the freshness computed for the same response agree on one instant.
function staleWikiPageCondition(now: number) {
	return sql`(
		${schema.wikiPages.status} IN ('stale', 'deprecated')
		OR (
			${schema.wikiPages.verifyInterval} IS NOT NULL
			AND (
				${schema.wikiPages.verifiedAt} IS NULL
				OR (${schema.wikiPages.verifiedAt} + ${schema.wikiPages.verifyInterval} * 86400) <= ${now}
			)
		)
	)`;
}

export async function listWikiPages(ctx: ServiceCtx, input: unknown) {
	const parsed = ListPagesInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const conditions = [
		eq(schema.wikiPages.workspaceId, ctx.workspaceId),
		// PROJ-496: trashed pages never appear in the normal listing.
		isNull(schema.wikiPages.deletedAt),
	];
	if (parsed.data.parentId) {
		conditions.push(eq(schema.wikiPages.parentId, parsed.data.parentId));
	}
	if (parsed.data.projectId) {
		conditions.push(eq(schema.wikiPages.projectId, parsed.data.projectId));
	}
	if (parsed.data.type) {
		conditions.push(eq(schema.wikiPages.type, parsed.data.type));
	}
	if (parsed.data.status) {
		conditions.push(eq(schema.wikiPages.status, parsed.data.status));
	}
	const tagsCond = tagsFilterCondition(parsed.data.tags ?? []);
	if (tagsCond) conditions.push(tagsCond);
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
			// PROJ-488 (R6): denormalized frontmatter metadata.
			type: schema.wikiPages.type,
			tags: schema.wikiPages.tags,
			status: schema.wikiPages.status,
			// eslint-disable-next-line camelcase
			verified_at: schema.wikiPages.verifiedAt,
			// eslint-disable-next-line camelcase
			verified_by: schema.wikiPages.verifiedBy,
			owners: schema.wikiPages.owners,
			// eslint-disable-next-line camelcase
			verify_interval: schema.wikiPages.verifyInterval,
			// eslint-disable-next-line camelcase
			is_template: schema.wikiPages.isTemplate,
		})
		.from(schema.wikiPages)
		.where(and(...conditions))
		.orderBy(asc(schema.wikiPages.title));

	return rows.map((r) => ({ ...r, url: wikiPagePath(r.slug) }));
}

// PROJ-486: FTS5 MATCH treats bare input as query syntax (AND/OR/NOT, column filters,
// prefix "*", etc). Wrap each whitespace-separated token in double quotes so raw user
// text is always treated as a literal phrase search, mirroring services/issues.ts's
// sanitizeFtsQuery for issues_fts.
function sanitizeWikiFtsQuery(q: string): string {
	return q
		.trim()
		.split(/\s+/)
		.filter((t) => Boolean(t) && /\w/.test(t))
		.map((t) => `"${t.replace(/"/g, '""')}"`)
		.join(" ");
}

// PROJ-486: title is weighted well above content and tags so a title match ranks
// above a match buried deep in body content — bm25() weight args are positional,
// one per wiki_fts column (page_id, workspace_id, title, content, tags); the first
// two are UNINDEXED so their weight is irrelevant, left at 0 for clarity.
const WIKI_FTS_BM25_WEIGHTS = "0, 0, 10.0, 1.0, 5.0";

// PROJ-488: a JSON-array column read through a raw D1 query (no drizzle json decoding).
function decodeJsonArrayColumn(value: unknown): string[] {
	if (Array.isArray(value)) return value as string[];
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export async function searchWiki(ctx: ServiceCtx, input: unknown) {
	const parsed = SearchWikiInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { query, limit, offset, projectId, updatedSince, type, status, tags } = parsed.data;

	const ftsQuery = sanitizeWikiFtsQuery(query);
	if (!ftsQuery) return [];

	if (projectId) {
		// PROJ-311: searching a specific project the user can't see returns nothing.
		if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
			return [];
		}
	}

	let q = `SELECT p.id, p.slug, p.title, p.project_id,
              p.type, p.tags, p.status, p.verified_at, p.verified_by, p.owners, p.verify_interval,
              snippet(wiki_fts, -1, '**', '**', '…', 24) as excerpt,
              bm25(wiki_fts, ${WIKI_FTS_BM25_WEIGHTS}) as rank
            FROM wiki_fts
            JOIN wiki_pages p ON p.id = wiki_fts.page_id
            -- PROJ-491 (R9): templates are a picker-only concern (list_wiki_templates), not
            -- search results — excluded unconditionally rather than behind an opt-in filter.
            WHERE wiki_fts MATCH ? AND wiki_fts.workspace_id = ?
              AND p.is_template = 0
              -- PROJ-496: FTS rows for a trashed page aren't purged until 30 days out —
              -- joining wiki_pages and filtering here (not just querying wiki_fts) is what
              -- keeps a trashed page out of search results in the meantime.
              AND p.deleted_at IS NULL`;
	const params: unknown[] = [ftsQuery, ctx.workspaceId];

	if (projectId) {
		q += " AND p.project_id = ?";
		params.push(projectId);
	} else {
		// PROJ-311: across the workspace, exclude project-scoped pages the user isn't granted.
		const visible = visibleProjectSqlFragment(ctx, "p.project_id");
		if (visible) {
			q += ` AND (p.project_id IS NULL OR ${visible.sql})`;
			params.push(...visible.params);
		}
	}

	if (updatedSince !== undefined) {
		q += " AND p.updated_at >= ?";
		params.push(updatedSince);
	}

	// PROJ-488 (R6): type/status/tags filters over the denormalized frontmatter
	// columns — combined (AND) with the FTS match, same as updatedSince/projectId above.
	if (type) {
		q += " AND p.type = ?";
		params.push(type);
	}
	if (status) {
		q += " AND p.status = ?";
		params.push(status);
	}
	if (tags && tags.length > 0) {
		// Any-of match, same semantics as listWikiPages's tagsFilterCondition.
		q += ` AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value IN (${tags.map(() => "?").join(",")}))`;
		params.push(...tags);
	}

	// PROJ-489 (R7): demote computed-stale/unverified/explicitly-stale-or-deprecated pages
	// below everything else, THEN rank by bm25 within each tier. `now` is bound once and
	// reused below for the freshness computed on each returned row, so the ordering and
	// the displayed freshness state always agree.
	const now = Math.floor(Date.now() / 1000);
	// PROJ-486: bm25() alone ties on equal-rank rows, which makes LIMIT/OFFSET
	// paging non-deterministic (duplicate/skip results across pages) — break
	// ties by page id for a stable order.
	q += ` ORDER BY (CASE WHEN (
	              p.status IN ('stale', 'deprecated')
	              OR (
	                p.verify_interval IS NOT NULL
	                AND (p.verified_at IS NULL OR (p.verified_at + p.verify_interval * 86400) <= ?)
	              )
	            ) THEN 1 ELSE 0 END),
	          bm25(wiki_fts, ${WIKI_FTS_BM25_WEIGHTS}), p.id LIMIT ? OFFSET ?`;
	params.push(now, limit, offset);

	const { results } = await ctx.db
		.prepare(q)
		.bind(...params)
		.all();
	return (results as Array<Record<string, unknown>>).map((r) => ({
		...r,
		// PROJ-488: this is a raw D1 query, so the JSON-array columns come back as the
		// stored TEXT rather than as arrays the way drizzle's `{ mode: "json" }` decodes
		// them for listWikiPages/getWikiPage. Decode here so every wiki surface returns
		// tags/owners with the same shape.
		tags: decodeJsonArrayColumn(r.tags),
		owners: decodeJsonArrayColumn(r.owners),
		// PROJ-489 (R7): null when the page has no verify_interval/status signal at all —
		// never fabricated (services/wiki-freshness.ts).
		freshness: computeFreshness({
			verifiedAt: r.verified_at as number | null,
			verifyInterval: r.verify_interval as number | null,
			status: r.status as string | null,
			now,
		}),
	}));
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
	// PROJ-488 (R6): denormalized frontmatter metadata.
	type: schema.wikiPages.type,
	tags: schema.wikiPages.tags,
	status: schema.wikiPages.status,
	// eslint-disable-next-line camelcase
	verified_at: schema.wikiPages.verifiedAt,
	// eslint-disable-next-line camelcase
	verified_by: schema.wikiPages.verifiedBy,
	owners: schema.wikiPages.owners,
	// eslint-disable-next-line camelcase
	verify_interval: schema.wikiPages.verifyInterval,
	// eslint-disable-next-line camelcase
	is_template: schema.wikiPages.isTemplate,
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
			and(
				eq(schema.wikiPages.id, redirect.pageId),
				eq(schema.wikiPages.workspaceId, workspaceId),
				// PROJ-496: a redirect to a page that's since been trashed does not resolve —
				// a trashed page is treated as gone, same as a hard-deleted one, until it's
				// undeleted (see the PR description for this call).
				isNull(schema.wikiPages.deletedAt)
			)
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
				eq(schema.wikiPages.workspaceId, ctx.workspaceId),
				isNull(schema.wikiPages.deletedAt)
			)
		)
		.get();
	// PROJ-483: live page always wins over a redirect, so reusing an old slug for a
	// new/renamed page never leaves getWikiPage returning an ambiguous result.
	const page = direct ?? (await resolveWikiPageByRedirect(orm, ctx.workspaceId, slugOrId));
	if (!page) throw new NotFoundError("Wiki page not found");
	await assertWikiPageVisible(ctx, page.project_id);
	return {
		...page,
		url: wikiPagePath(page.slug),
		// PROJ-489 (R7): computed/derived, not a stored column — surfaced for the page header.
		freshness: computeFreshness({
			verifiedAt: page.verified_at,
			verifyInterval: page.verify_interval,
			status: page.status,
		}),
	};
}

// PROJ-485: "what links here" — pages that link to `slugOrId` via a resolved wiki_links
// row. Resolves the target the same way getWikiPage does (live slug/id, then redirect
// fallback) and enforces the same visibility check before exposing anything.
export async function getWikiBacklinks(ctx: ServiceCtx, slugOrId: string): Promise<WikiBacklink[]> {
	const orm = drizzle(ctx.db, { schema });
	const direct = await orm
		.select({ id: schema.wikiPages.id, project_id: schema.wikiPages.projectId })
		.from(schema.wikiPages)
		.where(
			and(
				or(eq(schema.wikiPages.id, slugOrId), eq(schema.wikiPages.slug, slugOrId)),
				eq(schema.wikiPages.workspaceId, ctx.workspaceId),
				isNull(schema.wikiPages.deletedAt)
			)
		)
		.get();
	const page = direct ?? (await resolveWikiPageByRedirect(orm, ctx.workspaceId, slugOrId));
	if (!page) throw new NotFoundError("Wiki page not found");
	await assertWikiPageVisible(ctx, page.project_id);
	return backlinksForResolvedPage(ctx, { id: page.id });
}

// PROJ-485: re-exported so routes/wiki.ts and mcp/wiki.ts only need to import from this
// module, matching every other domain function's entry point.
export { backfillWikiLinks, listBrokenWikiLinks } from "./wiki-links";

// PROJ-491 (R9): resolves create_wiki_page's `templateSlug` to seed content — the target
// must exist and carry frontmatter `template: true`, or this throws a ValidationError
// rather than silently falling back to blank content. Strips the `template` flag itself
// out of the seeded content (a page created from a template isn't itself a template).
async function resolveTemplateContent(ctx: ServiceCtx, templateSlug: string): Promise<string> {
	let template: Awaited<ReturnType<typeof resolvePageByIdOrSlug>>;
	try {
		template = await resolvePageByIdOrSlug(ctx.db, templateSlug, ctx.workspaceId);
	} catch (e) {
		if (e instanceof NotFoundError) {
			throw new ValidationError({
				formErrors: [`templateSlug '${templateSlug}' does not resolve to an existing page`],
				fieldErrors: {},
			});
		}
		throw e;
	}
	await assertWikiPageVisible(ctx, template.projectId);
	const meta = parseWikiFrontmatter(template.content);
	if (!meta.isTemplate) {
		throw new ValidationError({
			formErrors: [`Page '${templateSlug}' is not a template (missing frontmatter template: true)`],
			fieldErrors: {},
		});
	}
	return stripTemplateFlag(template.content);
}

export async function createWikiPage(ctx: ServiceCtx, input: unknown) {
	const parsed = CreatePageSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { title, parentId, projectId, slug: customSlug, templateSlug } = parsed.data;

	await requireWikiWrite(ctx, projectId ?? null);

	if (parentId) {
		await validateNewPageParent(ctx.db, parentId, ctx.workspaceId, projectId);
	}

	const content = templateSlug
		? await resolveTemplateContent(ctx, templateSlug)
		: (parsed.data.content ?? "");

	const orm = drizzle(ctx.db, { schema });
	let slug = customSlug;
	if (!slug) {
		// PROJ-517: slugify's charset can't produce "/", but a symbol-only or non-Latin
		// title can still derive an empty or over-length slug — run it through the same
		// SlugSchema the custom-slug path is validated against rather than trusting it.
		// A title that fails this (CJK, emoji-only, etc.) still gets a usable page: fall
		// back to a short opaque slug rather than hard-failing creation, since the title
		// itself (unconstrained by SlugSchema) remains the actual display name.
		const derivedSlug = SlugSchema.safeParse(slugify(title));
		slug = derivedSlug.success ? derivedSlug.data : `page-${crypto.randomUUID().slice(0, 8)}`;
	}
	await assertSlugAvailable(orm, ctx.workspaceId, slug);
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	// PROJ-488 (R6): parse+validate the optional frontmatter block up front, so an
	// invalid frontmatter throws before any row is written (never a partial create).
	const meta = parseWikiFrontmatter(content ?? "");

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
			type: meta.type,
			tags: meta.tags,
			status: meta.status,
			verifiedAt: meta.verifiedAt,
			verifiedBy: meta.verifiedBy,
			owners: meta.owners,
			verifyInterval: meta.verifyInterval,
			isTemplate: meta.isTemplate,
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
	// PROJ-488: tags is now populated from frontmatter (space-joined — wiki_fts's default
	// unicode61 tokenizer splits on non-alphanumeric, so a comma join would tokenize
	// identically, but space matches how title/content are naturally tokenized).
	await ctx.db
		.prepare(
			"INSERT INTO wiki_fts (page_id, workspace_id, title, content, tags) VALUES (?, ?, ?, ?, ?)"
		)
		.bind(id, ctx.workspaceId, title, content ?? "", meta.tags.join(" "))
		.run();
	// PROJ-485: parse [[Target]]/URL links out of the new page's content into wiki_links.
	await reindexWikiLinks(ctx, orm, id, content ?? "");
	await recordActivity(ctx, { entityType: "wiki_page", entityId: id, action: "created" });
	// PROJ-493 (R11): a subtree watcher on an ancestor is notified of a page newly
	// created underneath them (there's no possible DIRECT watch on `id` yet — it didn't
	// exist until this insert). Template pages never notify (see wiki-watchers.ts).
	if (!meta.isTemplate) {
		await notifyWikiWatchers(ctx, {
			pageId: id,
			parentId: parentId ?? null,
			slug,
			title,
			action: "created",
		});
	}
	return { id, slug, projectId: projectId ?? null, url: wikiPagePath(slug), ...meta };
}

// PROJ-484: id of the most recently created revision for a page, or null if the page
// has never been edited (no revision row exists yet). This is the "current revision"
// pointer optimistic-locking compares a caller's baseRevisionId against — each content
// edit inserts a new revision snapshotting the pre-edit state, which moves this
// pointer forward, so a stale baseRevisionId always fails the equality check below.
// Raw SQL (not drizzle) so the ORDER BY can tiebreak on rowid: createdAt is unix
// SECONDS (repo convention), so two edits within the same second tie on it, and only
// rowid (monotonic insertion order) reliably picks the most recently inserted row.
// TOCTOU note: this read, the later revision insert, and the page update are not
// wrapped in one transaction/batch, so two concurrent writers who both read the same
// baseRevisionId can both pass this check and both succeed (last one wins on the page
// row, though each still gets its own revision snapshot). Acceptable for now — same
// class of race already accepted elsewhere in this file (slug availability, issue
// numbering) — but note it here since "optimistic locking" implies stronger.
async function getLatestRevisionId(db: D1Database, pageId: string): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT id FROM wiki_revisions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
		)
		.bind(pageId)
		.first<{ id: string }>();
	return row?.id ?? null;
}

// PROJ-484: content to diff a conflicting write's base against. Revisions snapshot
// PRE-edit content, so the content the caller actually had for revision pointer R is
// held by the NEXT-newer revision's snapshot (R's own `content` column is the state
// *before* R, i.e. one edit further back) — falling back to the page's live content
// when R is the latest revision. `null` means the caller read the page before it had
// ever been revised, so the oldest revision's snapshot (the first edit's pre-change
// content) is the base. An unknown/garbage baseRevisionId doesn't belong to this page
// and can't be resolved to any content, so it's rejected rather than silently diffed
// against an empty string (which would render as "everything added").
async function resolveBaseContent(
	db: D1Database,
	pageId: string,
	baseRevisionId: string | null,
	currentContent: string
): Promise<string> {
	if (baseRevisionId === null) {
		const row = await db
			.prepare(
				"SELECT content FROM wiki_revisions WHERE page_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1"
			)
			.bind(pageId)
			.first<{ content: string }>();
		return row?.content ?? "";
	}
	const baseRow = await db
		.prepare(
			"SELECT created_at as createdAt, rowid FROM wiki_revisions WHERE id = ? AND page_id = ?"
		)
		.bind(baseRevisionId, pageId)
		.first<{ createdAt: number; rowid: number }>();
	if (!baseRow) {
		throw new ValidationError({
			formErrors: ["baseRevisionId does not belong to this page"],
			fieldErrors: {},
		});
	}
	const nextRow = await db
		.prepare(
			`SELECT content FROM wiki_revisions
			 WHERE page_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
			 ORDER BY created_at ASC, rowid ASC LIMIT 1`
		)
		.bind(pageId, baseRow.createdAt, baseRow.createdAt, baseRow.rowid)
		.first<{ content: string }>();
	return nextRow?.content ?? currentContent;
}

// PROJ-484: LCS-based line diff. dp is O(n*m) time/memory, which is fine for typical
// wiki-page edits; MAX_DIFF_CELLS guards against pathological blowup on huge pages by
// falling back to a coarse "everything replaced" edit script instead of hanging.
const MAX_DIFF_CELLS = 1_000_000;

type DiffOp = { type: "equal" | "add" | "remove"; line: string };

function computeLineDiff(oldLines: string[], newLines: string[]): DiffOp[] {
	const n = oldLines.length;
	const m = newLines.length;
	if (n * m > MAX_DIFF_CELLS) {
		return [
			...oldLines.map((line): DiffOp => ({ type: "remove", line })),
			...newLines.map((line): DiffOp => ({ type: "add", line })),
		];
	}
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] =
				oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			ops.push({ type: "equal", line: oldLines[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: "remove", line: oldLines[i] });
			i++;
		} else {
			ops.push({ type: "add", line: newLines[j] });
			j++;
		}
	}
	while (i < n) {
		ops.push({ type: "remove", line: oldLines[i] });
		i++;
	}
	while (j < m) {
		ops.push({ type: "add", line: newLines[j] });
		j++;
	}
	return ops;
}

// PROJ-484: renders a standard unified diff (`--- base` / `+++ current`, `@@ -a,b +c,d @@`
// hunks with 3 lines of context) between a conflicting write's base content and the
// page's current content, so an agent can see exactly what changed and rebase.
export function buildUnifiedDiff(baseContent: string, currentContent: string): string {
	if (baseContent === currentContent) return "";
	const oldLines = baseContent.split("\n");
	const newLines = currentContent.split("\n");
	const ops = computeLineDiff(oldLines, newLines);

	const CONTEXT = 3;
	const changeIdxs = ops.reduce<number[]>((acc, op, idx) => {
		if (op.type !== "equal") acc.push(idx);
		return acc;
	}, []);
	if (changeIdxs.length === 0) return "";

	// Group nearby changes into hunks so their context ranges overlap into one block.
	const groups: Array<[number, number]> = [];
	let groupStart = changeIdxs[0];
	let groupEnd = changeIdxs[0];
	for (const idx of changeIdxs.slice(1)) {
		if (idx - groupEnd <= CONTEXT * 2) {
			groupEnd = idx;
		} else {
			groups.push([groupStart, groupEnd]);
			groupStart = idx;
			groupEnd = idx;
		}
	}
	groups.push([groupStart, groupEnd]);

	const hunks: string[] = [];
	for (const [gStart, gEnd] of groups) {
		const sliceStart = Math.max(0, gStart - CONTEXT);
		const sliceEnd = Math.min(ops.length - 1, gEnd + CONTEXT);
		const slice = ops.slice(sliceStart, sliceEnd + 1);

		let oldStart = 1;
		let newStart = 1;
		for (let k = 0; k < sliceStart; k++) {
			if (ops[k].type !== "add") oldStart++;
			if (ops[k].type !== "remove") newStart++;
		}
		const oldCount = slice.filter((op) => op.type !== "add").length;
		const newCount = slice.filter((op) => op.type !== "remove").length;

		const lines = slice.map((op) => {
			const prefix = op.type === "add" ? "+" : op.type === "remove" ? "-" : " ";
			return `${prefix}${op.line}`;
		});
		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join("\n")}`);
	}

	return `--- base\n+++ current\n${hunks.join("\n")}`;
}

// PROJ-486: mirrors issues.ts's reindexIssueFts — delete-then-reinsert the wiki_fts
// mirror row after a title/content edit. Re-reads the page rather than trusting the
// caller's partial `data` so a title-only or content-only update still reindexes the
// unchanged field's current value, not a stale/empty one.
async function reindexWikiFts(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle<typeof schema>>,
	id: string,
	data: { title?: string; content?: string }
): Promise<void> {
	if (data.title === undefined && data.content === undefined) return;

	const current = await orm
		.select({
			title: schema.wikiPages.title,
			content: schema.wikiPages.content,
			tags: schema.wikiPages.tags,
		})
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.id, id), eq(schema.wikiPages.workspaceId, ctx.workspaceId)))
		.get();
	if (!current) return;

	await ctx.db
		.prepare("DELETE FROM wiki_fts WHERE page_id = ? AND workspace_id = ?")
		.bind(id, ctx.workspaceId)
		.run();
	await ctx.db
		.prepare(
			"INSERT INTO wiki_fts (page_id, workspace_id, title, content, tags) VALUES (?, ?, ?, ?, ?)"
		)
		// PROJ-488: current.tags already reflects this write — reindexWikiFts runs
		// after the wikiPages UPDATE below applies (see call site in updateWikiPage).
		.bind(id, ctx.workspaceId, current.title, current.content, (current.tags ?? []).join(" "))
		.run();
}

// PROJ-486: chunked so a cascade delete of a large subtree stays under D1's 100-bound
// parameter cap (services/sql.ts#inChunks).
async function deleteWikiFtsEntries(ctx: ServiceCtx, pageIds: string[]): Promise<void> {
	await inChunks(pageIds, async (chunk) => {
		const placeholders = chunk.map(() => "?").join(",");
		await ctx.db
			.prepare(`DELETE FROM wiki_fts WHERE page_id IN (${placeholders}) AND workspace_id = ?`)
			.bind(...chunk, ctx.workspaceId)
			.run();
		return [];
	});
}

export async function updateWikiPage(ctx: ServiceCtx, idOrSlug: string, input: unknown) {
	const parsed = UpdatePageSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { title, content, parentId, slug, baseRevisionId, summary } = parsed.data;
	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await requireWikiWrite(ctx, page.projectId);
	const now = Math.floor(Date.now() / 1000);
	const orm = drizzle(ctx.db, { schema });

	// PROJ-484: optimistic locking. Omitting baseRevisionId keeps today's last-write-wins
	// behavior during the transition (deprecated — see mcp/wiki.ts docs). When supplied,
	// it must match the page's current latest revision id, or the write is rejected with
	// a structured conflict (current revision id + a unified diff) so the caller can
	// rebase and retry.
	if (baseRevisionId !== undefined) {
		const currentRevisionId = await getLatestRevisionId(ctx.db, page.id);
		if (currentRevisionId !== baseRevisionId) {
			const baseContent = await resolveBaseContent(ctx.db, page.id, baseRevisionId, page.content);
			const diff = buildUnifiedDiff(baseContent, page.content);
			throw new ConflictError(
				"Wiki page has been modified since baseRevisionId; rebase and retry",
				{ currentRevisionId, diff }
			);
		}
	}

	if (parentId !== undefined && parentId !== null) {
		await validateUpdatedPageParent(ctx.db, parentId, ctx.workspaceId, page);
	}

	// PROJ-488 (R6): parse+validate frontmatter up front (before any write) when content
	// changes, so invalid frontmatter throws before the revision insert below — never a
	// partial update. `undefined` (not reparsed) means the update doesn't touch content,
	// so buildWikiPageUpdateSet leaves the page's existing metadata columns untouched.
	const meta = content !== undefined ? parseWikiFrontmatter(content) : undefined;

	// PROJ-483: renaming the slug — check the new slug isn't already live, then leave a
	// redirect from the old slug to this page so existing links keep resolving.
	const isRename = slug !== undefined && slug !== page.slug;
	if (isRename) {
		await assertSlugAvailable(orm, ctx.workspaceId, slug, page.id);
	}

	// PROJ-484: a revision snapshots a CONTENT edit; a title-only update (content
	// undefined) has nothing to diff against later, so it doesn't create a revision row
	// and any `summary` passed alongside a title-only update is silently dropped rather
	// than stored somewhere with no corresponding snapshot.
	if (content !== undefined) {
		// PROJ-484: title snapshot is the page's title as of THIS revision (i.e. before
		// this update applies any new title) — consistent with content, which snapshots
		// the pre-edit value too. summary is this edit's optional changelog note.
		await orm.insert(schema.wikiRevisions).values({
			id: crypto.randomUUID(),
			pageId: page.id,
			content: page.content,
			title: page.title,
			summary: summary ?? null,
			authorId: ctx.userId,
			createdAt: now,
		});
	}

	const setData = buildWikiPageUpdateSet(now, ctx.userId, { title, content, parentId, slug, meta });
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

	await reindexWikiFts(ctx, orm, page.id, { title, content });
	// PROJ-485: outgoing links are derived purely from content — a title/slug/parent-only
	// update leaves them unchanged, so only reindex when content actually changed.
	if (content !== undefined) {
		await reindexWikiLinks(ctx, orm, page.id, content);
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

	// PROJ-493 (R11): covers plain edits, verify_wiki_page, and restore (both routed
	// through this function). meta is only recomputed when content changed — otherwise
	// fall back to the page's existing isTemplate, which this write left untouched.
	const isTemplate = meta?.isTemplate ?? page.isTemplate;
	if (!isTemplate) {
		await notifyWikiWatchers(ctx, {
			pageId: page.id,
			parentId: parentId !== undefined ? parentId : page.parentId,
			slug: slug ?? page.slug,
			title: title ?? page.title,
			action: "updated",
		});
	}

	return { ok: true, url: wikiPagePath(slug ?? page.slug) };
}

// PROJ-489 (R7): stamps verified_at/verified_by using the CALLING user's identity —
// never a caller-supplied value, so an agent can't backdate/forge another user's
// verification. Frontmatter (not just the denormalized columns) is the canonical source
// (PRD principle 1), so this rewrites the page's content frontmatter block and routes
// through updateWikiPage's normal content-write path (revision snapshot, frontmatter
// re-parse into columns, FTS/link reindex, activity log) rather than UPDATE-ing the
// verified_at/verified_by columns directly — that would drift out of sync with content
// the moment someone next makes an unrelated content-only edit (parseWikiFrontmatter
// would re-parse the page's still-stale frontmatter and silently wipe the stamp).
export async function verifyWikiPage(ctx: ServiceCtx, idOrSlug: string) {
	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await requireWikiWrite(ctx, page.projectId);

	const orm = drizzle(ctx.db, { schema });
	const user = await orm
		.select({ email: schema.users.email })
		.from(schema.users)
		.where(eq(schema.users.id, ctx.userId))
		.get();
	if (!user) throw new NotFoundError("Calling user not found");

	// PROJ-489: stamping the frontmatter is a read-modify-write of the WHOLE content, so
	// without a base revision a content edit landing between the read and the write would
	// be silently reverted by a verification click — exactly the loss PROJ-484 added
	// optimistic locking for. Read the base revision id BEFORE the content it describes:
	// a writer racing us either lands before both reads (we stamp on top of their edit) or
	// bumps the latest revision past our base (updateWikiPage rejects with a conflict).
	const baseRevisionId = await getLatestRevisionId(ctx.db, page.id);
	const current = await resolvePageByIdOrSlug(ctx.db, page.id, ctx.workspaceId);

	const now = Math.floor(Date.now() / 1000);
	const newContent = stampWikiFrontmatterVerification(current.content, now, user.email);
	await updateWikiPage(ctx, page.id, { content: newContent, summary: "Verified", baseRevisionId });

	// Re-derive from the same frontmatter just written, so the response matches exactly
	// what a subsequent read would parse back out (rather than re-fetching the page).
	const meta = parseWikiFrontmatter(newContent);
	return {
		ok: true,
		verifiedAt: meta.verifiedAt,
		verifiedBy: meta.verifiedBy,
		url: wikiPagePath(page.slug),
		freshness: computeFreshness({
			verifiedAt: meta.verifiedAt,
			verifyInterval: meta.verifyInterval,
			status: meta.status,
			now,
		}),
	};
}

// PROJ-489 (R7): the maintenance queue — pages that are computed-stale (verify_interval
// elapsed), unverified (verify_interval declared but never verified), or explicitly
// `status: stale|deprecated`. Same condition as searchWiki's ranking demotion
// (staleWikiPageCondition above), so "what search demotes" and "what this queue lists"
// never disagree.
export async function listStaleWikiPages(ctx: ServiceCtx, input: unknown) {
	const parsed = ListStaleWikiPagesInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, limit, offset } = parsed.data;

	if (projectId) {
		// PROJ-311: same as searchWiki — querying a project the caller can't see returns nothing.
		if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
			return [];
		}
	}

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);
	const conditions = [
		eq(schema.wikiPages.workspaceId, ctx.workspaceId),
		staleWikiPageCondition(now),
		// PROJ-491 (R9): a template shouldn't show up in the maintenance queue — it isn't
		// content that needs re-verification, it's a skeleton other pages are seeded from.
		eq(schema.wikiPages.isTemplate, false),
		// PROJ-496: a trashed page needs no re-verification either.
		isNull(schema.wikiPages.deletedAt),
	];
	if (projectId) {
		conditions.push(eq(schema.wikiPages.projectId, projectId));
	} else {
		// PROJ-311: workspace-wide, exclude project-scoped pages the caller isn't granted.
		const visible = visibleProjectPredicate(ctx, schema.wikiPages.projectId);
		if (visible) {
			const cond = or(isNull(schema.wikiPages.projectId), visible);
			if (cond) conditions.push(cond);
		}
	}

	const rows = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			// eslint-disable-next-line camelcase
			project_id: schema.wikiPages.projectId,
			status: schema.wikiPages.status,
			// eslint-disable-next-line camelcase
			verified_at: schema.wikiPages.verifiedAt,
			// eslint-disable-next-line camelcase
			verified_by: schema.wikiPages.verifiedBy,
			// eslint-disable-next-line camelcase
			verify_interval: schema.wikiPages.verifyInterval,
			// eslint-disable-next-line camelcase
			updated_at: schema.wikiPages.updatedAt,
		})
		.from(schema.wikiPages)
		.where(and(...conditions))
		.orderBy(asc(schema.wikiPages.updatedAt))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({
		...r,
		url: wikiPagePath(r.slug),
		freshness: computeFreshness({
			verifiedAt: r.verified_at,
			verifyInterval: r.verify_interval,
			status: r.status,
			now,
		}),
	}));
}

// PROJ-490 (R8): a "section" is a markdown ATX heading (`#`..`######`) plus every
// line up to the next heading of ANY level (or end of document). Headings are
// addressed by their exact trimmed text; nested subheadings become their own
// separate sections rather than being folded into their parent's — flat and
// predictable, and it's what makes the heading lookup a simple linear scan.
const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// PROJ-490: a `#` at the start of a line is only a heading in ordinary block context.
// Two other blocks routinely contain lines that look exactly like one and must be
// skipped, or section boundaries land inside them and a patch shreds the page:
//   - fenced code blocks — `# install deps` in a ```bash block is the single most
//     common line in a runbook, the PRD's headline page type;
//   - the leading YAML frontmatter block — `# a yaml comment` sits before any real
//     heading, so "patching" it would rewrite the metadata block itself.
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const FRONTMATTER_DELIM_RE = /^---\s*$/;

type HeadingSection = { heading: string; level: number; startLine: number; endLine: number };

function parseHeadingSections(content: string): HeadingSection[] {
	const lines = content.split("\n");
	const headings: Array<{ level: number; heading: string; startLine: number }> = [];
	let fence: string | null = null;
	// A frontmatter block only counts when `---` is the very first line.
	let inFrontmatter = lines.length > 0 && FRONTMATTER_DELIM_RE.test(lines[0]);
	lines.forEach((line, idx) => {
		if (inFrontmatter) {
			if (idx > 0 && FRONTMATTER_DELIM_RE.test(line)) inFrontmatter = false;
			return;
		}
		const fenceMatch = FENCE_RE.exec(line);
		if (fence !== null) {
			// A closing fence must use the same character and be at least as long.
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
				fence = null;
			}
			return;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			return;
		}
		const m = ATX_HEADING_RE.exec(line);
		if (m) headings.push({ level: m[1].length, heading: m[2].trim(), startLine: idx });
	});
	return headings.map((h, i) => ({
		heading: h.heading,
		level: h.level,
		startLine: h.startLine,
		endLine: i + 1 < headings.length ? headings[i + 1].startLine : lines.length,
	}));
}

function findSections(sections: HeadingSection[], heading: string): HeadingSection[] {
	const target = heading.trim();
	return sections.filter((s) => s.heading === target);
}

function extractSectionText(content: string, section: HeadingSection): string {
	return content.split("\n").slice(section.startLine, section.endLine).join("\n");
}

function trimTrailingBlankLines(lines: string[]): string[] {
	const out = [...lines];
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	return out;
}

function trimLeadingBlankLines(lines: string[]): string[] {
	const out = [...lines];
	while (out.length > 0 && out[0].trim() === "") out.shift();
	return out;
}

// PROJ-490: appends at the absolute end of the document, with a single blank-line
// separator. Never section-scoped, so it has no target section to conflict-check —
// see patchWikiPage's comment on why append_to_page skips the section-lock entirely.
function appendToPageEnd(content: string, text: string): string {
	const trimmed = content.replace(/\s+$/, "");
	if (trimmed === "") return `${text.trimEnd()}\n`;
	return `${trimmed}\n\n${text.trimEnd()}\n`;
}

// PROJ-490: applies one of the three heading-addressed ops to `content`, given the
// section it resolved to (already confirmed to exist in the CURRENT content by the
// caller). The heading line itself is always preserved — only the body under it
// (append_to_section/replace_section) or the position right after it
// (insert_after_heading) changes.
function applySectionOp(
	content: string,
	section: HeadingSection,
	op: Extract<
		PatchWikiPageInput,
		{ op: "append_to_section" | "replace_section" | "insert_after_heading" }
	>
): string {
	const lines = content.split("\n");
	const before = lines.slice(0, section.startLine);
	const headingLine = lines[section.startLine];
	const bodyLines = lines.slice(section.startLine + 1, section.endLine);
	const afterLines = lines.slice(section.endLine);

	let newBodyLines: string[];
	if (op.op === "append_to_section") {
		const trimmedBody = trimTrailingBlankLines(bodyLines);
		newBodyLines =
			trimmedBody.length > 0 ? [...trimmedBody, "", ...op.text.split("\n")] : op.text.split("\n");
	} else if (op.op === "replace_section") {
		newBodyLines = op.text.trim() === "" ? [] : op.text.split("\n");
	} else {
		const trimmedBody = trimTrailingBlankLines(trimLeadingBlankLines(bodyLines));
		newBodyLines =
			trimmedBody.length > 0 ? [...op.text.split("\n"), "", ...trimmedBody] : op.text.split("\n");
	}

	const newSectionLines = [headingLine, ...newBodyLines];
	const separator = afterLines.length > 0 ? [""] : [];
	return [...before, ...newSectionLines, ...separator, ...afterLines].join("\n");
}

// PROJ-490 (R8): patch_wiki_page — section-addressed patch ops so multiple agents can
// co-edit disjoint parts of the same page without conflicting.
//
// Conflict detection is deliberately SECTION-scoped, not whole-page: reusing
// updateWikiPage's baseRevisionId-vs-latest-revision check verbatim would make two
// agents patching two different sections of the same page conflict with each other
// just because the page's overall revision advanced — which defeats the entire point
// of section patch ops (PRD R8: "disjoint-section writes never conflict"). Instead:
//   1. Resolve the target section in the page's CURRENT content. Missing there ->
//      NotFoundError with the current heading list (covers both "never existed" and
//      "existed at base but was deleted/renamed since" — same response shape for both,
//      since from the caller's perspective they're indistinguishable: the heading they
//      asked for isn't there to patch).
//   2. If baseRevisionId doesn't match the page's current latest revision, resolve
//      the SAME section's text as of baseRevisionId (via the same resolveBaseContent
//      helper update_wiki_page uses for its whole-page diff) and compare only that
//      section's text, base vs current. Only reject if that comparison differs —
//      edits to other sections in between never trip this check.
// Tradeoff accepted: this compares base-section-text directly against current-section-
// text, skipping over any intermediate revisions. A section that was edited and then
// edited BACK to its original text between base and now is (correctly) treated as no
// conflict — but a section edited by someone else and then re-edited to a different
// value that happens to text-match some intermediate state is not distinguished from
// "unchanged since base". This is the same class of approximation update_wiki_page
// already accepts for its whole-page check (see getLatestRevisionId's TOCTOU note
// above) — full section-level history tracking is out of scope for R8.
//
// append_to_page is exempt from the section-lock entirely: appending at the document's
// tail is commutative with any edit elsewhere in the page (it can never clobber
// content another writer touched), so there is no section to compare and no way for
// it to conflict. baseRevisionId is still required on the input for API consistency
// and because a revision snapshot is still created either way.
export async function patchWikiPage(ctx: ServiceCtx, idOrSlug: string, input: unknown) {
	const parsed = PatchWikiPageInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const data = parsed.data;

	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await requireWikiWrite(ctx, page.projectId);
	const currentContent = page.content;

	let newContent: string;
	if (data.op === "append_to_page") {
		newContent = appendToPageEnd(currentContent, data.text);
	} else {
		const currentSections = parseHeadingSections(currentContent);
		const currentMatches = findSections(currentSections, data.heading);
		if (currentMatches.length === 0) {
			throw new NotFoundError(`Heading '${data.heading}' not found`, {
				currentHeadings: currentSections.map((s) => s.heading),
			});
		}
		// PROJ-490: heading text is the whole address, so a page carrying the same
		// heading twice (a "## Notes" under two different parents, or an H1 and H2 that
		// read the same) has no unambiguous target. Silently taking the first match
		// would write to a section the caller never looked at — rejected instead, per
		// the PRD's "integrity over convenience" principle.
		if (currentMatches.length > 1) {
			throw new ValidationError({
				formErrors: [
					`Heading '${data.heading}' is ambiguous — it appears ${currentMatches.length} times ` +
						`(levels ${currentMatches.map((s) => `h${s.level}`).join(", ")}); ` +
						"patch operations need a unique heading",
				],
				// PROJ-523: alongside the prose, expose which heading levels collided as a
				// structured field — an agent shouldn't have to regex the sentence to recover
				// this, and NotFoundError's sibling case already hands back currentHeadings.
				fieldErrors: { heading: currentMatches.map((s) => `h${s.level}`) },
			});
		}
		const currentSection = currentMatches[0];

		const currentRevisionId = await getLatestRevisionId(ctx.db, page.id);
		if (currentRevisionId !== data.baseRevisionId) {
			const baseContent = await resolveBaseContent(
				ctx.db,
				page.id,
				data.baseRevisionId,
				currentContent
			);
			// A heading that was absent — or ambiguous — at base but resolves uniquely
			// now means the section itself changed shape underneath the caller, so the
			// empty base text below (correctly) trips the conflict check.
			const baseMatches = findSections(parseHeadingSections(baseContent), data.heading);
			const baseSectionText =
				baseMatches.length === 1 ? extractSectionText(baseContent, baseMatches[0]) : "";
			const currentSectionText = extractSectionText(currentContent, currentSection);
			if (baseSectionText !== currentSectionText) {
				throw new ConflictError(
					`Section '${data.heading}' has been modified since baseRevisionId; rebase and retry`,
					{ currentRevisionId, diff: buildUnifiedDiff(baseSectionText, currentSectionText) }
				);
			}
		}

		newContent = applySectionOp(currentContent, currentSection, data);
	}

	const now = Math.floor(Date.now() / 1000);
	const orm = drizzle(ctx.db, { schema });
	// PROJ-490: parse+validate frontmatter up front, same as updateWikiPage, so
	// invalid frontmatter (which a patch op cannot introduce on its own since it only
	// edits section bodies, but a malformed source page could already carry) throws
	// before the revision insert below — never a partial write.
	const meta = parseWikiFrontmatter(newContent);

	await orm.insert(schema.wikiRevisions).values({
		id: crypto.randomUUID(),
		pageId: page.id,
		content: page.content,
		title: page.title,
		summary: data.summary ?? null,
		authorId: ctx.userId,
		createdAt: now,
	});

	const setData = buildWikiPageUpdateSet(now, ctx.userId, { content: newContent, meta });
	await orm
		.update(schema.wikiPages)
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle set() requires typed columns; setData is safe
		.set(setData as any)
		.where(eq(schema.wikiPages.id, page.id));

	await reindexWikiFts(ctx, orm, page.id, { content: newContent });
	await reindexWikiLinks(ctx, orm, page.id, newContent);
	await recordActivity(ctx, {
		entityType: "wiki_page",
		entityId: page.id,
		action: "updated",
		diff: buildWikiPageUpdateDiff({ content: newContent }),
	});

	// PROJ-493 (R11): meta is always reparsed from newContent above (patches only touch
	// section bodies, so template status can't itself change here, but the check stays
	// consistent with the other write paths).
	if (!meta.isTemplate) {
		await notifyWikiWatchers(ctx, {
			pageId: page.id,
			parentId: page.parentId,
			slug: page.slug,
			title: page.title,
			action: "updated",
		});
	}

	return { ok: true, url: wikiPagePath(page.slug) };
}

// PROJ-491 (R9): the template picker — pages carrying frontmatter `template: true`,
// visible to the caller. Deliberately not filtered by the search/staleness exclusion
// above (this IS the discovery path templates are meant to be found through).
export async function listWikiTemplates(ctx: ServiceCtx, input: unknown) {
	const parsed = ListWikiTemplatesInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId } = parsed.data;

	if (projectId) {
		// PROJ-311: same as searchWiki/listStaleWikiPages — a project the caller can't
		// see returns nothing.
		if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
			return [];
		}
	}

	const orm = drizzle(ctx.db, { schema });
	const conditions = [
		eq(schema.wikiPages.workspaceId, ctx.workspaceId),
		eq(schema.wikiPages.isTemplate, true),
		// PROJ-496: a trashed template isn't offered by the picker.
		isNull(schema.wikiPages.deletedAt),
	];
	if (projectId) {
		conditions.push(eq(schema.wikiPages.projectId, projectId));
	} else {
		const visible = visibleProjectPredicate(ctx, schema.wikiPages.projectId);
		if (visible) {
			const cond = or(isNull(schema.wikiPages.projectId), visible);
			if (cond) conditions.push(cond);
		}
	}

	const rows = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			// eslint-disable-next-line camelcase
			project_id: schema.wikiPages.projectId,
			type: schema.wikiPages.type,
		})
		.from(schema.wikiPages)
		.where(and(...conditions))
		.orderBy(asc(schema.wikiPages.title));

	return rows.map((r) => ({ ...r, url: wikiPagePath(r.slug) }));
}

// PROJ-491 (R9): seeds the built-in templates (runbook, adr, spec) for a newly created
// workspace, under a "Templates" parent page (slugged "page-templates" — see
// RESERVED_WIKI_SLUGS) — same content the 0047 migration backfills
// for pre-existing workspaces (kept in sync by hand, same as seedDefaultTaskTypes/0016 for
// task types). Authored as the workspace's creator (the only user guaranteed to exist yet).
export async function seedDefaultWikiTemplates(
	db: D1Database,
	workspaceId: string,
	userId: string
): Promise<void> {
	const orm = drizzle(db, { schema });
	const now = Math.floor(Date.now() / 1000);

	const parentId = crypto.randomUUID();
	await orm.insert(schema.wikiPages).values({
		id: parentId,
		workspaceId,
		projectId: null,
		slug: "page-templates",
		title: "Templates",
		content: "",
		parentId: null,
		createdById: userId,
		updatedById: userId,
		createdAt: now,
		updatedAt: now,
	});

	const templates: Array<{ slug: string; title: string; type: string; body: string }> = [
		{
			slug: "templates-runbook",
			title: "Runbook Template",
			type: "runbook",
			body: [
				"# Runbook: [Title]",
				"",
				"## Purpose",
				"",
				"What this runbook is for and when to use it.",
				"",
				"## Preconditions",
				"",
				"-",
				"",
				"## Steps",
				"",
				"1.",
				"2.",
				"3.",
				"",
				"## Rollback",
				"",
				"## Verification",
				"",
			].join("\n"),
		},
		{
			slug: "templates-adr",
			title: "ADR Template",
			type: "adr",
			body: [
				"# ADR NNNN: [Title]",
				"",
				"## Status",
				"",
				"Proposed",
				"",
				"## Context",
				"",
				"## Decision",
				"",
				"## Consequences",
				"",
			].join("\n"),
		},
		{
			slug: "templates-spec",
			title: "Spec Template",
			type: "spec",
			body: [
				"# [Feature] Spec",
				"",
				"## Problem",
				"",
				"## Goals",
				"",
				"## Non-goals",
				"",
				"## Design",
				"",
				"## Open questions",
				"",
			].join("\n"),
		},
	];

	for (const t of templates) {
		const content = `---\ntype: ${t.type}\nstatus: draft\ntemplate: true\n---\n${t.body}`;
		await orm.insert(schema.wikiPages).values({
			id: crypto.randomUUID(),
			workspaceId,
			projectId: null,
			slug: t.slug,
			title: t.title,
			content,
			parentId,
			createdById: userId,
			updatedById: userId,
			createdAt: now,
			updatedAt: now,
			type: t.type,
			status: "draft",
			isTemplate: true,
		});
	}
}

// PROJ-238: breadth-first walk of parent_id children, chunked to stay under D1's
// bound-parameter cap regardless of subtree size.
// PROJ-496: only walks LIVE descendants — an already-trashed descendant (trashed
// independently, or a leftover from an earlier soft-delete) is left with its own
// deleted_at untouched rather than being folded into this cascade and having its
// retention clock reset.
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
						eq(schema.wikiPages.workspaceId, workspaceId),
						isNull(schema.wikiPages.deletedAt)
					)
				)
		);
		frontier = children.map((c) => c.id);
		descendants.push(...frontier);
	}
	return descendants;
}

// PROJ-496 follow-up: mirror of collectDescendantIds for the undelete path — walks
// parent_id children that are IN THE TRASH and share the exact same trash_batch_id as
// the root being restored (deleteWikiPage's cascade branch stamps the whole subtree
// with one batch id in a single call). Batch id — not deleted_at — is what identifies
// "trashed together": two independent single-page trashes can land in the same
// wall-clock second and would otherwise be mistaken for one cascade batch. A
// descendant trashed independently (different batch id) is left out, same as
// collectDescendantIds leaves it out of a subsequent cascade delete.
async function collectCascadeTrashedDescendantIds(
	db: D1Database,
	rootId: string,
	workspaceId: string,
	trashBatchId: string | null
): Promise<string[]> {
	if (trashBatchId === null) return [];
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
						eq(schema.wikiPages.workspaceId, workspaceId),
						eq(schema.wikiPages.trashBatchId, trashBatchId)
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

// PROJ-311: workspace-level pages need a workspace admin/owner; a project-scoped
// page can also be deleted by someone with a project-admin grant.
async function requireWikiDelete(ctx: ServiceCtx, projectId: string | null): Promise<void> {
	if (projectId === null) {
		if (ctx.role !== "admin" && ctx.role !== "owner")
			throw new ForbiddenError("Insufficient permissions");
	} else if (!isWorkspaceAdmin(ctx.role)) {
		if ((await effectiveProjectRole(ctx, projectId)) !== "admin")
			throw new ForbiddenError("Insufficient permissions");
	}
}

// PROJ-496 (R14): deletes are now SOFT — this stamps deleted_at instead of removing
// rows. Everything the pre-R14 hard delete used to clean up immediately (R2 attachment
// objects, wiki_links, wiki_watchers, wiki_drafts, wiki_fts rows, wiki_redirects) now
// waits for purgeExpiredWikiPages, 30 days later — see deleteWikiPageAttachments and
// the other per-table helpers below, which purgeExpiredWikiPages calls directly.
//
// PROJ-509: resolved via resolvePageByIdOrSlug (id-or-slug + redirect fallback), same
// as getWikiPage/updateWikiPage/getWikiBacklinks/listWikiRevisions/getWikiRevision —
// a delete-by-old-slug-after-rename request resolves to the same page rather than
// 404ing, for consistency across every other page-reference entry point.
export async function deleteWikiPage(ctx: ServiceCtx, idOrSlug: string, options?: unknown) {
	const idCheck = IdSchema.safeParse(idOrSlug);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	const parsedOptions = DeleteWikiPageOptionsSchema.safeParse(options ?? {});
	if (!parsedOptions.success) throw new ValidationError(parsedOptions.error.flatten());
	const { cascade } = parsedOptions.data;

	const orm = drizzle(ctx.db, { schema });
	const resolved = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	const page = {
		id: resolved.id,
		slug: resolved.slug,
		title: resolved.title,
		projectId: resolved.projectId,
		parentId: resolved.parentId,
		isTemplate: resolved.isTemplate,
	};

	await requireWikiDelete(ctx, page.projectId);

	const now = Math.floor(Date.now() / 1000);
	// PROJ-493 (R11)/PROJ-496: slug/title/projectId are captured here (not re-read off
	// the row later) so list_wiki_changes can still report what a "deleted" event was
	// about even after the page drops out of every deleted_at IS NULL read path, and
	// still enforce the workspace-scoping/project-visibility invariant for it — see
	// wiki-watchers.ts#extractDeletedPageInfo.
	const deleteDiffBase = { slug: page.slug, title: page.title, projectId: page.projectId };

	if (cascade) {
		// PROJ-496: moves the WHOLE subtree to trash as a single unit — every id here gets
		// the same deleted_at AND trash_batch_id stamp, so undeleting the root later doesn't
		// leave descendants behind (undeleting a descendant independently is still possible,
		// see undeleteWikiPage's "orphan-in-trash" note). trash_batch_id (not deleted_at) is
		// what identifies batch membership — see collectCascadeTrashedDescendantIds.
		const descendantIds = await collectDescendantIds(ctx.db, page.id, ctx.workspaceId);
		const allIds = [page.id, ...descendantIds];
		const trashBatchId = crypto.randomUUID();
		// PROJ-485: read before the trash stamp — not that it would change (soft delete
		// doesn't touch wiki_links), but kept for parity with the pre-R14 read-before-write
		// ordering and because a future purge racing this call shouldn't matter either way.
		const linkedByCount = await countBacklinkSources(ctx, allIds);
		if (!page.isTemplate) {
			await notifyWikiWatchers(ctx, {
				pageId: page.id,
				parentId: page.parentId,
				slug: page.slug,
				title: page.title,
				action: "deleted",
			});
		}
		// PROJ-493: subtree watchers rooted at/above the cascade root got the single
		// notification above, but someone watching one of the DESCENDANTS directly would
		// otherwise hear nothing at all about their page being trashed.
		if (descendantIds.length > 0) {
			const descendants = await inChunks(descendantIds, (chunk) =>
				orm
					.select({
						id: schema.wikiPages.id,
						slug: schema.wikiPages.slug,
						title: schema.wikiPages.title,
						isTemplate: schema.wikiPages.isTemplate,
					})
					.from(schema.wikiPages)
					.where(
						and(
							inArray(schema.wikiPages.id, chunk),
							eq(schema.wikiPages.workspaceId, ctx.workspaceId)
						)
					)
			);
			await notifyCascadeDescendantWatchers(ctx, descendants);
		}
		await inChunks(allIds, async (chunk) => {
			await orm
				.update(schema.wikiPages)
				.set({ deletedAt: now, trashBatchId })
				.where(inArray(schema.wikiPages.id, chunk));
			return [];
		});
		await recordActivity(ctx, {
			entityType: "wiki_page",
			entityId: page.id,
			action: "deleted",
			diff: { ...deleteDiffBase, cascade: true, deletedCount: allIds.length },
		});
		return { ok: true, deletedCount: allIds.length, linkedByCount };
	}

	// PROJ-238: no FK constraint on parent_id, so a plain (non-cascade) trash would
	// otherwise leave children pointing at a parent that's no longer visible. Default
	// behavior is to promote them to the trashed page's own parent (which may be null,
	// i.e. the root) — unchanged by PROJ-496, this still runs against the LIVE children
	// (a child that's independently trashed keeps its own parent_id untouched, same as
	// the pre-R14 behavior for a hard-deleted child).
	await orm
		.update(schema.wikiPages)
		.set({ parentId: page.parentId })
		.where(and(eq(schema.wikiPages.parentId, page.id), isNull(schema.wikiPages.deletedAt)));

	const linkedByCount = await countBacklinkSources(ctx, [page.id]);
	if (!page.isTemplate) {
		await notifyWikiWatchers(ctx, {
			pageId: page.id,
			parentId: page.parentId,
			slug: page.slug,
			title: page.title,
			action: "deleted",
		});
	}
	await orm
		.update(schema.wikiPages)
		.set({ deletedAt: now, trashBatchId: crypto.randomUUID() })
		.where(eq(schema.wikiPages.id, page.id));
	await recordActivity(ctx, {
		entityType: "wiki_page",
		entityId: page.id,
		action: "deleted",
		diff: deleteDiffBase,
	});
	return { ok: true, deletedCount: 1, linkedByCount };
}

// PROJ-496 (R14): undelete a trashed page. Takes an ID only (not a slug) — a slug is
// only unique among LIVE pages (0051_wiki_trash.sql's partial index), so more than one
// trashed page can carry the same now-recycled slug; an id is the only unambiguous
// reference once a page is in the trash. Same permission as deleteWikiPage (reversing a
// delete needs the same authority as performing one).
//
// Design decisions (see PR description for the full reasoning):
//   - Parent's trash state is NOT checked. Undeleting a page whose parent is still
//     trashed (or was cascade-trashed alongside it) is allowed; the page shows up as a
//     root in list/tree views until its parent is also undeleted — the same "orphan"
//     rendering getWikiTree already does for any page whose parent isn't in the current
//     result set (map.has() check), so this needs no special-casing there.
//   - Slug reuse: every page in the restore batch (root AND every descendant) has its
//     slug re-checked against LIVE pages only (assertSlugAvailable, which now filters
//     deleted_at IS NULL) and rejected with a structured ConflictError naming the
//     colliding slug if a new page has since taken it — the caller must rename the new
//     page (or the page being undeleted, via update_wiki_page, which isn't possible
//     until it's live again) to resolve the collision. No partial restore happens: the
//     whole batch is checked before any row is updated.
export async function undeleteWikiPage(ctx: ServiceCtx, id: string) {
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });

	const orm = drizzle(ctx.db, { schema });
	const page = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			projectId: schema.wikiPages.projectId,
			parentId: schema.wikiPages.parentId,
			isTemplate: schema.wikiPages.isTemplate,
			deletedAt: schema.wikiPages.deletedAt,
			trashBatchId: schema.wikiPages.trashBatchId,
		})
		.from(schema.wikiPages)
		.where(and(eq(schema.wikiPages.id, id), eq(schema.wikiPages.workspaceId, ctx.workspaceId)))
		.get();
	if (!page) throw new NotFoundError("Wiki page not found");
	if (page.deletedAt === null) {
		throw new ValidationError({ formErrors: ["Page is not in the trash"], fieldErrors: {} });
	}

	await requireWikiDelete(ctx, page.projectId);

	// PROJ-496 follow-up: restore the whole cascade-trashed subtree, not just the root —
	// a page trashed via deleteWikiPage's cascade branch stamps every descendant with the
	// same trash_batch_id, so walking descendants that share that exact id recovers
	// exactly the batch that was trashed together (see collectCascadeTrashedDescendantIds).
	// Independently-trashed descendants (a different batch id) are left alone.
	const descendantIds = await collectCascadeTrashedDescendantIds(
		ctx.db,
		page.id,
		ctx.workspaceId,
		page.trashBatchId
	);
	const allIds = [page.id, ...descendantIds];

	const descendantRows =
		descendantIds.length > 0
			? await inChunks(descendantIds, (chunk) =>
					orm
						.select({
							id: schema.wikiPages.id,
							slug: schema.wikiPages.slug,
							title: schema.wikiPages.title,
							isTemplate: schema.wikiPages.isTemplate,
						})
						.from(schema.wikiPages)
						.where(
							and(
								inArray(schema.wikiPages.id, chunk),
								eq(schema.wikiPages.workspaceId, ctx.workspaceId)
							)
						)
				)
			: [];

	// PROJ-496 follow-up: every id in the cascade batch must clear the slug check, not
	// just the root — the partial-unique slug index only enforces uniqueness among LIVE
	// pages, so a descendant's slug can have been taken by an unrelated new page while
	// the whole subtree sat in the trash. Checking only the root let that case fall
	// through to a raw SQLite constraint violation on the batch UPDATE below (a 500)
	// instead of the structured ConflictError the design here promises.
	await assertSlugAvailable(orm, ctx.workspaceId, page.slug, page.id);
	for (const descendant of descendantRows) {
		await assertSlugAvailable(orm, ctx.workspaceId, descendant.slug, descendant.id);
	}

	const now = Math.floor(Date.now() / 1000);
	await inChunks(allIds, async (chunk) => {
		await orm
			.update(schema.wikiPages)
			.set({ deletedAt: null, trashBatchId: null, updatedAt: now, updatedById: ctx.userId })
			.where(inArray(schema.wikiPages.id, chunk));
		return [];
	});

	// PROJ-496: recorded as "updated" (not a new activity/notification action) so it
	// slots into the existing typed action union (recordActivity, WikiChangeEvent,
	// notifyWikiWatchers) rather than widening it repo-wide for a single edge case — a
	// restore genuinely IS "this page changed state and is worth telling watchers about",
	// which is exactly what an "updated" event already means to every consumer.
	await recordActivity(ctx, {
		entityType: "wiki_page",
		entityId: page.id,
		action: "updated",
		diff: {
			restored: true,
			slug: page.slug,
			title: page.title,
			projectId: page.projectId,
			restoredCount: allIds.length,
		},
	});
	if (!page.isTemplate) {
		await notifyWikiWatchers(ctx, {
			pageId: page.id,
			parentId: page.parentId,
			slug: page.slug,
			title: page.title,
			action: "updated",
		});
	}
	// PROJ-496 follow-up: mirrors deleteWikiPage's cascade branch notifying descendant
	// watchers on trash — without this, someone watching a descendant directly hears
	// about the delete but never a matching "restored" event on cascade undelete.
	if (descendantRows.length > 0) {
		await notifyCascadeDescendantWatchers(ctx, descendantRows, "updated");
	}

	return {
		ok: true,
		id: page.id,
		slug: page.slug,
		url: wikiPagePath(page.slug),
		restoredCount: allIds.length,
	};
}

// PROJ-496 (R14): trash listing, scoped the same way listWikiPages is — a project-scoped
// trashed page is only listed for callers who could see that project (workspace admins
// see everything).
export async function listWikiTrash(ctx: ServiceCtx, input: unknown) {
	const parsed = ListWikiTrashInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, limit, offset } = parsed.data;

	if (projectId) {
		if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
			return [];
		}
	}

	const orm = drizzle(ctx.db, { schema });
	const conditions = [
		eq(schema.wikiPages.workspaceId, ctx.workspaceId),
		isNotNull(schema.wikiPages.deletedAt),
	];
	if (projectId) {
		conditions.push(eq(schema.wikiPages.projectId, projectId));
	} else {
		const visible = visibleProjectPredicate(ctx, schema.wikiPages.projectId);
		if (visible) {
			const cond = or(isNull(schema.wikiPages.projectId), visible);
			if (cond) conditions.push(cond);
		}
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
			deleted_at: schema.wikiPages.deletedAt,
		})
		.from(schema.wikiPages)
		.where(and(...conditions))
		.orderBy(desc(schema.wikiPages.deletedAt))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({
		...r,
		// PROJ-496: purge is due 30 days after deletedAt — surfaced so a UI/agent can show
		// "N days left" without re-deriving the retention constant.
		purgeAfter: (r.deleted_at ?? 0) + WIKI_TRASH_RETENTION_SECONDS,
	}));
}

// PROJ-496 (R14): permanently removes every page in this workspace that's been trashed
// for at least WIKI_TRASH_RETENTION_SECONDS — R2 attachment objects, wiki_revisions,
// wiki_links, wiki_watchers, wiki_drafts, wiki_fts rows, and wiki_redirects that were
// left in place at (soft) delete time, plus a re-parent fixup for any live child left
// pointing at a page in this batch. Owner/admin only, same as backfill_wiki_links —
// this is a maintenance action over the whole workspace, not scoped to a single
// project's grants. Also reachable via a daily Workers Cron Trigger (see the
// `scheduled` handler in index.ts, which iterates every workspace) in addition to the
// manual REST/MCP call.
export async function purgeExpiredWikiPages(
	ctx: ServiceCtx
): Promise<{ purgedCount: number; purgedIds: string[] }> {
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const orm = drizzle(ctx.db, { schema });
	const cutoff = Math.floor(Date.now() / 1000) - WIKI_TRASH_RETENTION_SECONDS;
	const expired = await orm
		.select({ id: schema.wikiPages.id, parentId: schema.wikiPages.parentId })
		.from(schema.wikiPages)
		.where(
			and(
				eq(schema.wikiPages.workspaceId, ctx.workspaceId),
				isNotNull(schema.wikiPages.deletedAt),
				lte(schema.wikiPages.deletedAt, cutoff)
			)
		);
	const ids = expired.map((p) => p.id);
	if (ids.length === 0) return { purgedCount: 0, purgedIds: [] };

	// PROJ-238/PROJ-496: a live child can end up pointing at a page that's about to be
	// purged — e.g. it was cascade-trashed alongside its parent, then undeleted on its
	// own while the parent stayed in the trash. parent_id has no FK, so without this
	// fixup a purge would leave it dangling. Walk each purged page's parent chain past
	// any other page that's ALSO being purged in this batch, mirroring deleteWikiPage's
	// re-parent-to-nearest-surviving-ancestor behavior.
	const expiredSet = new Set(ids);
	const parentById = new Map(expired.map((p) => [p.id, p.parentId]));
	const resolveReparentTarget = (id: string): string | null => {
		let current = parentById.get(id) ?? null;
		const seen = new Set<string>();
		while (current !== null && expiredSet.has(current) && !seen.has(current)) {
			seen.add(current);
			current = parentById.get(current) ?? null;
		}
		return current;
	};
	for (const id of ids) {
		await orm
			.update(schema.wikiPages)
			.set({ parentId: resolveReparentTarget(id) })
			.where(and(eq(schema.wikiPages.parentId, id), isNull(schema.wikiPages.deletedAt)));
	}

	await inChunks(ids, async (chunk) => {
		await deleteWikiPageAttachments(ctx, orm, chunk);
		return [];
	});
	await inChunks(ids, async (chunk) => {
		await orm.delete(schema.wikiRevisions).where(inArray(schema.wikiRevisions.pageId, chunk));
		return [];
	});
	await inChunks(ids, async (chunk) => {
		await orm.delete(schema.wikiPages).where(inArray(schema.wikiPages.id, chunk));
		return [];
	});
	await deleteWikiFtsEntries(ctx, ids);
	await deleteWikiLinksForPages(ctx, ids);
	await clearIncomingLinkTargets(ctx, ids);
	await deleteWikiWatchersForPages(ctx, ids);
	await deleteWikiDraftsForPages(ctx, ids);
	// PROJ-407-style defensive cleanup, same rationale as every other per-table helper
	// here: D1 doesn't guarantee FK enforcement on every connection, so wiki_redirects'
	// ON DELETE CASCADE on page_id is mirrored explicitly.
	await inChunks(ids, async (chunk) => {
		await orm
			.delete(schema.wikiRedirects)
			.where(
				and(
					eq(schema.wikiRedirects.workspaceId, ctx.workspaceId),
					inArray(schema.wikiRedirects.pageId, chunk)
				)
			);
		return [];
	});

	return { purgedCount: ids.length, purgedIds: ids };
}

export async function getWikiTree(ctx: ServiceCtx, projectId?: string): Promise<TreeNode[]> {
	const orm = drizzle(ctx.db, { schema });
	const conditions = [
		eq(schema.wikiPages.workspaceId, ctx.workspaceId),
		// PROJ-496: a trashed page (and, naturally, its whole trashed subtree) drops out of
		// the tree. A live page whose PARENT is trashed becomes a root in the tree instead
		// of disappearing — see the map.has() check below, unchanged — which is the "orphan-
		// in-trash" case documented on undeleteWikiPage.
		isNull(schema.wikiPages.deletedAt),
	];
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
			// PROJ-514: so the sidebar's type filter dropdown can derive its options from
			// this same tree fetch instead of issuing a second, unfiltered listWikiPages call.
			type: schema.wikiPages.type,
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
			url: wikiPagePath(p.slug),
			type: p.type,
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

// PROJ-509: resolves via resolvePageByIdOrSlug (id-or-slug + redirect fallback) so a
// renamed page's old slug still resolves here, matching getWikiPage/updateWikiPage/
// getWikiBacklinks instead of 404ing on the exact reference PROJ-484's optimistic-
// locking workflow tells agents to fetch.
export async function listWikiRevisions(ctx: ServiceCtx, idOrSlug: string) {
	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await assertWikiPageVisible(ctx, page.projectId);
	const orm = drizzle(ctx.db, { schema });

	return (
		orm
			.select({
				id: schema.wikiRevisions.id,
				title: schema.wikiRevisions.title,
				summary: schema.wikiRevisions.summary,
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
			// PROJ-484: createdAt is unix SECONDS (repo convention), so edits within the same
			// second tie on it; tiebreak on rowid (monotonic insertion order) so "most recent
			// first" is actually correct, matching getLatestRevisionId's raw-SQL equivalent.
			.orderBy(desc(schema.wikiRevisions.createdAt), desc(sql`wiki_revisions.rowid`))
	);
}

// PROJ-509: same id-or-slug + redirect resolution as listWikiRevisions above.
export async function getWikiRevision(ctx: ServiceCtx, idOrSlug: string, revisionId: string) {
	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await assertWikiPageVisible(ctx, page.projectId);
	const orm = drizzle(ctx.db, { schema });

	const revision = await orm
		.select({
			id: schema.wikiRevisions.id,
			content: schema.wikiRevisions.content,
			title: schema.wikiRevisions.title,
			summary: schema.wikiRevisions.summary,
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

// PROJ-492 (R10): server-side unified diff between one revision (`revisionId`) and either
// another revision or the page's current content (`against`, defaulting to "current").
// Reuses buildUnifiedDiff (PROJ-484) — same format as update_wiki_page/patch_wiki_page's
// conflict responses, so the UI/agent can render both with one diff renderer. Each
// revision's own `content` column already IS the snapshot at that point in time (unlike
// resolveBaseContent's off-by-one lookahead, which exists only to answer "what did the
// caller actually have"), so both sides are read directly with no shifting.
export async function getWikiRevisionDiff(
	ctx: ServiceCtx,
	idOrSlug: string,
	revisionId: string,
	input: unknown
) {
	const parsed = WikiRevisionDiffInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { against } = parsed.data;

	const page = await resolvePageByIdOrSlug(ctx.db, idOrSlug, ctx.workspaceId);
	await assertWikiPageVisible(ctx, page.projectId);
	const orm = drizzle(ctx.db, { schema });

	const fromRevision = await orm
		.select({ content: schema.wikiRevisions.content })
		.from(schema.wikiRevisions)
		.where(and(eq(schema.wikiRevisions.id, revisionId), eq(schema.wikiRevisions.pageId, page.id)))
		.get();
	if (!fromRevision) throw new NotFoundError("Revision not found");

	let toContent: string;
	if (against === "current") {
		toContent = page.content;
	} else {
		const toRevision = await orm
			.select({ content: schema.wikiRevisions.content })
			.from(schema.wikiRevisions)
			.where(and(eq(schema.wikiRevisions.id, against), eq(schema.wikiRevisions.pageId, page.id)))
			.get();
		if (!toRevision) throw new NotFoundError("Revision not found");
		toContent = toRevision.content;
	}

	return { from: revisionId, to: against, diff: buildUnifiedDiff(fromRevision.content, toContent) };
}
