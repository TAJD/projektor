import { drizzle, schema } from "@projektor/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
import {
	backlinksForResolvedPage,
	clearIncomingLinkTargets,
	countBacklinkSources,
	deleteWikiLinksForPages,
	reindexWikiLinks,
	type WikiBacklink,
} from "./wiki-links";

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

// PROJ-487: "view" is the shell path segment the Worker's pretty-URL fallback serves
// static assets from (/wiki/view/index.html) — a page slugged "view" would collide
// with it and never resolve. Reserved outright rather than special-cased in routing.
const RESERVED_WIKI_SLUGS = new Set(["view"]);

// PROJ-483: wiki_pages(workspace_id, slug) is unique — surface a structured
// ConflictError instead of letting the constraint throw a raw D1 error.
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
): Promise<{ id: string; slug: string; title: string; content: string; projectId: string | null }> {
	const orm = drizzle(db, { schema });
	const direct = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
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
			title: redirected.title,
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

export async function searchWiki(ctx: ServiceCtx, input: unknown) {
	const parsed = SearchWikiInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { query, limit, offset, projectId, updatedSince } = parsed.data;
	// PROJ-486: `type`/`tags`/`status` are accepted by the schema for forward
	// compatibility with R6/R7 but intentionally unused here — see schemas/wiki.ts.

	const ftsQuery = sanitizeWikiFtsQuery(query);
	if (!ftsQuery) return [];

	if (projectId) {
		// PROJ-311: searching a specific project the user can't see returns nothing.
		if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
			return [];
		}
	}

	let q = `SELECT p.id, p.slug, p.title, p.project_id,
              snippet(wiki_fts, -1, '**', '**', '…', 24) as excerpt,
              bm25(wiki_fts, ${WIKI_FTS_BM25_WEIGHTS}) as rank
            FROM wiki_fts
            JOIN wiki_pages p ON p.id = wiki_fts.page_id
            WHERE wiki_fts MATCH ? AND wiki_fts.workspace_id = ?`;
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

	// PROJ-486: bm25() alone ties on equal-rank rows, which makes LIMIT/OFFSET
	// paging non-deterministic (duplicate/skip results across pages) — break
	// ties by page id for a stable order.
	q += ` ORDER BY bm25(wiki_fts, ${WIKI_FTS_BM25_WEIGHTS}), p.id LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	const { results } = await ctx.db
		.prepare(q)
		.bind(...params)
		.all();
	// PROJ-489 (R7, not landed): no freshness model exists yet, so freshness is
	// omitted-as-null rather than fabricated.
	return (results as Array<Record<string, unknown>>).map((r) => ({ ...r, freshness: null }));
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
	return { ...page, url: wikiPagePath(page.slug) };
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
				eq(schema.wikiPages.workspaceId, ctx.workspaceId)
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
	// PROJ-486: tags is left empty until R6 (PROJ-488) populates it from frontmatter.
	await ctx.db
		.prepare(
			"INSERT INTO wiki_fts (page_id, workspace_id, title, content, tags) VALUES (?, ?, ?, ?, ?)"
		)
		.bind(id, ctx.workspaceId, title, content ?? "", "")
		.run();
	// PROJ-485: parse [[Target]]/URL links out of the new page's content into wiki_links.
	await reindexWikiLinks(ctx, orm, id, content ?? "");
	await recordActivity(ctx, { entityType: "wiki_page", entityId: id, action: "created" });
	return { id, slug, projectId: projectId ?? null, url: wikiPagePath(slug) };
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
function buildUnifiedDiff(baseContent: string, currentContent: string): string {
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
		.select({ title: schema.wikiPages.title, content: schema.wikiPages.content })
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
		.bind(id, ctx.workspaceId, current.title, current.content, "")
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

	return { ok: true, url: wikiPagePath(slug ?? page.slug) };
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
		// PROJ-485: read before the delete — target_page_id is ON DELETE SET NULL, so the
		// count would read as 0 once the pages are gone. Non-blocking: surfaced as info on
		// the response, matching the PRD's "delete warnings" (not a hard block).
		const linkedByCount = await countBacklinkSources(ctx, allIds);
		await inChunks(allIds, async (chunk) => {
			await deleteWikiPageAttachments(ctx, orm, chunk);
			return [];
		});
		await inChunks(allIds, async (chunk) => {
			await orm.delete(schema.wikiPages).where(inArray(schema.wikiPages.id, chunk));
			return [];
		});
		await deleteWikiFtsEntries(ctx, allIds);
		// PROJ-407-style defensive cleanup: mirror the FK's ON DELETE CASCADE/SET NULL at
		// the app level too, since D1 doesn't guarantee FK enforcement on every connection.
		await deleteWikiLinksForPages(ctx, allIds);
		await clearIncomingLinkTargets(ctx, allIds);
		await recordActivity(ctx, {
			entityType: "wiki_page",
			entityId: page.id,
			action: "deleted",
			diff: { cascade: true, deletedCount: allIds.length },
		});
		return { ok: true, deletedCount: allIds.length, linkedByCount };
	}

	// PROJ-238: no FK constraint on parent_id, so a plain delete would otherwise leave
	// children pointing at a row that no longer exists. Default behavior is to promote
	// them to the deleted page's own parent (which may be null, i.e. the root).
	await orm
		.update(schema.wikiPages)
		.set({ parentId: page.parentId })
		.where(eq(schema.wikiPages.parentId, page.id));

	const linkedByCount = await countBacklinkSources(ctx, [page.id]);
	await deleteWikiPageAttachments(ctx, orm, [page.id]);
	await orm.delete(schema.wikiPages).where(eq(schema.wikiPages.id, page.id));
	await deleteWikiFtsEntries(ctx, [page.id]);
	await deleteWikiLinksForPages(ctx, [page.id]);
	await clearIncomingLinkTargets(ctx, [page.id]);
	await recordActivity(ctx, { entityType: "wiki_page", entityId: page.id, action: "deleted" });
	return { ok: true, deletedCount: 1, linkedByCount };
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
			url: wikiPagePath(p.slug),
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
