// PROJ-485: server-side wiki link graph. Parses [[Target]] / [[Target|label]] wikilinks
// and same-workspace wiki URLs out of a page's content on every write, resolves each to
// a page id (or leaves it unresolved for broken-link reporting), and stores the result in
// `wiki_links` — id-backed so renames never break a link (target_title is kept purely for
// display/re-resolution, target_page_id is the source of truth).
//
// No dependency on services/wiki.ts (avoids a circular import) — page resolution/
// visibility for a *specific* page stays in wiki.ts, which calls into this file's
// `backlinksForResolvedPage` after resolving. listBrokenWikiLinks/backfillWikiLinks
// don't need a single resolved page so they're self-contained here.
import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
// PROJ-496 (R14): a trashed page is treated as gone for link resolution purposes — see
// resolveTitleTargets/resolveSlugTarget/backlinksForResolvedPage/listBrokenWikiLinks
// below for the `isNull(schema.wikiPages.deletedAt)` filters this adds.
import { safeDecodeURIComponent, wikiPagePath } from "../lib/urls";
import { ListBrokenWikiLinksInputSchema } from "../schemas/wiki";
import { effectiveProjectRole, isWorkspaceAdmin, visibleProjectPredicate } from "./access";
import { ForbiddenError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

type Orm = ReturnType<typeof drizzle<typeof schema>>;

// Mirrors apps/web/src/utils/markdown.ts's resolveWikilinks regex — same link syntax
// rules, server-side.
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
// Markdown link syntax `[label](url)` — used to catch same-workspace wiki URLs
// (`/wiki/:slug`, `/wiki?slug=...`, or the relative `?slug=...` form markdown.ts emits
// for already-resolved wikilinks).
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

type ParsedLinkTarget = { kind: "title"; title: string } | { kind: "slug"; slug: string };

function extractWikiSlugFromUrl(url: string): string | null {
	// Only relative, path-rooted URLs are treated as same-workspace links. An absolute
	// URL (http://, https://, //host/...) is never resolved here — we have no reliable
	// request origin at parse time to compare it against, so treating "strip whatever
	// origin is present" as "same workspace" would wrongly index links to other hosts
	// as same-workspace links (even a same-origin absolute URL is written as relative
	// by the app, so this doesn't lose any real link).
	if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url)) return null;
	const pathMatch = url.match(/^\/wiki\/([a-z0-9-]+)\/?$/i);
	const queryMatch = pathMatch ? null : url.match(/[?&]slug=([^&]+)/);
	const raw = pathMatch?.[1] ?? queryMatch?.[1];
	if (!raw) return null;
	// PROJ-510: a malformed percent-escape makes decodeURIComponent throw. This runs
	// mid-reindex, after the content write and the old wiki_links delete have already
	// committed, so an uncaught throw leaves the page's links wiped. An undecodable
	// URL is treated as "not a wiki link" rather than propagating.
	return safeDecodeURIComponent(raw);
}

// cofferdam-ignore: Design.OrphanExport: part of the service API; used internally for parsing wiki link targets
export function parseWikiLinkTargets(content: string): ParsedLinkTarget[] {
	const targets: ParsedLinkTarget[] = [];
	for (const m of content.matchAll(WIKILINK_RE)) {
		const title = m[1].trim();
		if (title) targets.push({ kind: "title", title });
	}
	for (const m of content.matchAll(MD_LINK_RE)) {
		const slug = extractWikiSlugFromUrl(m[1].trim());
		if (slug) targets.push({ kind: "slug", slug });
	}
	return targets;
}

// Resolves all title-kind targets in one query (rather than one round trip per link),
// matched case-insensitively. Page titles aren't unique like slugs are (PROJ-483 only
// enforces slug uniqueness); when more than one page shares a (lowercased) title, this
// picks whichever row the query happens to return first — an arbitrary but stable-ish
// match, not a documented/guaranteed one. Undocumented behavior, not a bug: titles were
// never meant to be a stable identifier, slugs are.
async function resolveTitleTargets(
	orm: Orm,
	workspaceId: string,
	titles: readonly string[]
): Promise<Map<string, string>> {
	const byLower = new Map<string, string>();
	if (titles.length === 0) return byLower;
	const lowered = [...new Set(titles.map((t) => t.toLowerCase()))];
	const rows = await inChunks(lowered, (chunk) =>
		orm
			.select({ id: schema.wikiPages.id, title: schema.wikiPages.title })
			.from(schema.wikiPages)
			.where(
				and(
					eq(schema.wikiPages.workspaceId, workspaceId),
					sql`lower(${schema.wikiPages.title}) IN (${sql.join(
						chunk.map((t) => sql`${t}`),
						sql`, `
					)})`,
					isNull(schema.wikiPages.deletedAt)
				)
			)
	);
	for (const row of rows) {
		const key = row.title.toLowerCase();
		if (!byLower.has(key)) byLower.set(key, row.id);
	}
	return byLower;
}

async function resolveSlugTarget(
	orm: Orm,
	workspaceId: string,
	slug: string
): Promise<{ id: string; title: string } | null> {
	const direct = await orm
		.select({ id: schema.wikiPages.id, title: schema.wikiPages.title })
		.from(schema.wikiPages)
		.where(
			and(
				eq(schema.wikiPages.workspaceId, workspaceId),
				eq(schema.wikiPages.slug, slug),
				isNull(schema.wikiPages.deletedAt)
			)
		)
		.get();
	if (direct) return direct;
	// PROJ-483 redirects: an old slug still resolves to its page.
	const redirect = await orm
		.select({ pageId: schema.wikiRedirects.pageId })
		.from(schema.wikiRedirects)
		.where(
			and(eq(schema.wikiRedirects.workspaceId, workspaceId), eq(schema.wikiRedirects.oldSlug, slug))
		)
		.get();
	if (!redirect) return null;
	const page = await orm
		.select({ id: schema.wikiPages.id, title: schema.wikiPages.title })
		.from(schema.wikiPages)
		.where(
			and(
				eq(schema.wikiPages.id, redirect.pageId),
				eq(schema.wikiPages.workspaceId, workspaceId),
				// PROJ-496: same "trashed = gone" rule as resolveWikiPageByRedirect in
				// services/wiki.ts — a link to a page's old slug doesn't resolve while the
				// page is in the trash.
				isNull(schema.wikiPages.deletedAt)
			)
		)
		.get();
	return page ?? null;
}

type ResolvedLink = { targetPageId: string | null; targetTitle: string };

async function resolveLinkTargets(
	orm: Orm,
	workspaceId: string,
	targets: readonly ParsedLinkTarget[]
): Promise<ResolvedLink[]> {
	// Dedupe by resolved page id (or the raw unresolved key) so a page linking to the
	// same target multiple times only gets one wiki_links row.
	const resolved = new Map<string, ResolvedLink>();

	// Title-kind targets resolve in one batched query instead of one round trip per
	// link (a page with N distinct title-links previously made N sequential queries).
	const titleTargets = targets.filter(
		(t): t is Extract<ParsedLinkTarget, { kind: "title" }> => t.kind === "title"
	);
	const titleMatches = await resolveTitleTargets(
		orm,
		workspaceId,
		titleTargets.map((t) => t.title)
	);
	for (const t of titleTargets) {
		const targetPageId = titleMatches.get(t.title.toLowerCase()) ?? null;
		const key = targetPageId ?? `title:${t.title.toLowerCase()}`;
		if (!resolved.has(key)) resolved.set(key, { targetPageId, targetTitle: t.title });
	}

	// Slug-kind targets (from same-workspace wiki URLs) each need a redirect-fallback
	// lookup, so they stay sequential rather than batched.
	for (const t of targets) {
		if (t.kind !== "slug") continue;
		const found = await resolveSlugTarget(orm, workspaceId, t.slug);
		const key = found?.id ?? `slug:${t.slug.toLowerCase()}`;
		if (!resolved.has(key)) {
			resolved.set(key, { targetPageId: found?.id ?? null, targetTitle: found?.title ?? t.slug });
		}
	}
	return [...resolved.values()];
}

// D1 caps bound params at 100; each row binds 6 params (id, workspaceId, sourcePageId,
// targetPageId, targetTitle, createdAt) — 15 rows/insert stays comfortably under that
// with headroom, unlike services/sql.ts#inChunks (calibrated for single-param-per-item
// IN-list queries, not multi-column inserts).
const LINK_INSERT_CHUNK_SIZE = 15;

/**
 * Builds (without executing) the DELETE + chunked re-INSERT statements that recompute a
 * page's outgoing wiki_links rows from its current content — the write half of
 * reindexWikiLinks, split out so services/wiki.ts can fold these statements into the same
 * db.batch() as the page's content write, revision insert, and FTS reindex (PROJ-511).
 * All resolution (parsing + the resolveLinkTargets reads) happens BEFORE this returns, so
 * by the time these statements exist there is nothing left to throw between them and the
 * delete — the whole write becomes one atomic D1 batch when passed to ctx.db.batch().
 */
export async function buildWikiLinksReindexStatements(
	ctx: ServiceCtx,
	orm: Orm,
	sourcePageId: string,
	content: string
): Promise<D1PreparedStatement[]> {
	const targets = parseWikiLinkTargets(content);
	const resolved =
		targets.length > 0 ? await resolveLinkTargets(orm, ctx.workspaceId, targets) : [];
	const now = Math.floor(Date.now() / 1000);
	const rows = resolved.map((r) => ({
		id: crypto.randomUUID(),
		workspaceId: ctx.workspaceId,
		sourcePageId,
		targetPageId: r.targetPageId,
		targetTitle: r.targetTitle,
		createdAt: now,
	}));

	const statements: D1PreparedStatement[] = [
		ctx.db
			.prepare("DELETE FROM wiki_links WHERE source_page_id = ? AND workspace_id = ?")
			.bind(sourcePageId, ctx.workspaceId),
	];
	for (let i = 0; i < rows.length; i += LINK_INSERT_CHUNK_SIZE) {
		const chunk = rows.slice(i, i + LINK_INSERT_CHUNK_SIZE);
		const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
		const params = chunk.flatMap((r) => [
			r.id,
			r.workspaceId,
			r.sourcePageId,
			r.targetPageId,
			r.targetTitle,
			r.createdAt,
		]);
		statements.push(
			ctx.db
				.prepare(
					`INSERT INTO wiki_links (id, workspace_id, source_page_id, target_page_id, target_title,
						created_at) VALUES ${placeholders}`
				)
				.bind(...params)
		);
	}
	return statements;
}

/**
 * Recompute a page's outgoing wiki_links rows from its current content: delete-then-
 * reinsert, mirroring services/wiki.ts's reindexWikiFts. Call after every content write
 * (create or update) — never partially, since a stale row would misreport backlinks.
 *
 * Runs the statements from buildWikiLinksReindexStatements as their own atomic db.batch —
 * used by callers (e.g. backfillWikiLinks) that don't fold link reindexing into a larger
 * page-write batch themselves. services/wiki.ts's createWikiPage/updateWikiPage/
 * patchWikiPage call buildWikiLinksReindexStatements directly instead, to include these
 * statements in the same batch as the content write/revision/FTS reindex (PROJ-511).
 */
// cofferdam-ignore: Design.OrphanExport: available for direct use; prefer buildWikiLinksReindexStatements for batches
export async function reindexWikiLinks(
	ctx: ServiceCtx,
	orm: Orm,
	sourcePageId: string,
	content: string
): Promise<void> {
	const statements = await buildWikiLinksReindexStatements(ctx, orm, sourcePageId, content);
	await ctx.db.batch(statements);
}

/**
 * One-time backfill: recompute wiki_links for every existing page in the workspace.
 * D1 migrations are pure SQL and can't run this parsing logic, so it's exposed as an
 * idempotent (delete-then-reinsert per page, safe to re-run) owner/admin-gated action
 * instead — see mcp/wiki.ts's backfill_wiki_links tool / routes/wiki.ts's REST
 * equivalent, and the PR description for why this shape was chosen over a standalone
 * script.
 */
export async function backfillWikiLinks(ctx: ServiceCtx): Promise<{ pagesProcessed: number }> {
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const orm = drizzle(ctx.db, { schema });
	const pages = await orm
		.select({ id: schema.wikiPages.id, content: schema.wikiPages.content })
		.from(schema.wikiPages)
		.where(eq(schema.wikiPages.workspaceId, ctx.workspaceId));

	for (const page of pages) {
		await reindexWikiLinks(ctx, orm, page.id, page.content);
	}
	return { pagesProcessed: pages.length };
}

// Called from services/wiki.ts's deleteWikiPage so a deleted page's outgoing link rows
// don't linger (ON DELETE CASCADE on source_page_id already guarantees this at the DB
// level for D1 connections that enforce FKs, but PROJ-407 established that isn't
// guaranteed for every connection — mirrors deleteWikiPageAttachments's rationale).
export async function deleteWikiLinksForPages(ctx: ServiceCtx, pageIds: string[]): Promise<void> {
	await inChunks(pageIds, async (chunk) => {
		const placeholders = chunk.map(() => "?").join(",");
		await ctx.db
			.prepare(
				`DELETE FROM wiki_links WHERE source_page_id IN (${placeholders}) AND workspace_id = ?`
			)
			.bind(...chunk, ctx.workspaceId)
			.run();
		return [];
	});
}

// Called from services/wiki.ts's deleteWikiPage alongside deleteWikiLinksForPages —
// the same app-level-mirrors-the-FK rationale (PROJ-407), but for the *incoming* side.
// ON DELETE SET NULL on target_page_id already guarantees this at the DB level for
// connections that enforce FKs; this is the defensive fallback for connections that
// don't, so a deleted page's id never lingers as a dangling target_page_id (which
// would make the link invisible to list_broken_wiki_links, since that only looks for
// target_page_id IS NULL). Only nulls target_page_id — target_title is left untouched
// so the link still shows up as broken with its original display text.
export async function clearIncomingLinkTargets(ctx: ServiceCtx, pageIds: string[]): Promise<void> {
	await inChunks(pageIds, async (chunk) => {
		const placeholders = chunk.map(() => "?").join(",");
		await ctx.db
			.prepare(
				`UPDATE wiki_links SET target_page_id = NULL WHERE target_page_id IN (${placeholders}) AND workspace_id = ?`
			)
			.bind(...chunk, ctx.workspaceId)
			.run();
		return [];
	});
}

// PROJ-485: count of distinct pages that link to any page in `pageIds`, for delete
// warnings ("N pages link here"). Must be read BEFORE the delete runs — target_page_id
// is ON DELETE SET NULL, so the count would read as 0 afterwards.
export async function countBacklinkSources(ctx: ServiceCtx, pageIds: string[]): Promise<number> {
	if (pageIds.length === 0) return 0;
	const orm = drizzle(ctx.db, { schema });
	const rows = await inChunks(pageIds, (chunk) =>
		orm
			.select({ sourcePageId: schema.wikiLinks.sourcePageId })
			.from(schema.wikiLinks)
			.where(
				and(
					eq(schema.wikiLinks.workspaceId, ctx.workspaceId),
					inArray(schema.wikiLinks.targetPageId, chunk)
				)
			)
			.groupBy(schema.wikiLinks.sourcePageId)
	);
	// Exclude self-links (a page linking to itself isn't "another page" linking here).
	// Dedup across chunks too, since a source page could link to targets that land in
	// different chunks and otherwise be counted more than once.
	const distinctSources = new Set(
		rows.map((r) => r.sourcePageId).filter((id) => !pageIds.includes(id))
	);
	return distinctSources.size;
}

// PROJ-485: best-effort citing context for a backlink — the raw text surrounding the
// first occurrence of the link syntax in the source page's current content. Returns
// null rather than guessing if the exact text can't be located (e.g. content changed
// since the link was indexed).
function extractSnippet(content: string, targetTitle: string): string | null {
	const marker = `[[${targetTitle.toLowerCase()}`;
	const idx = content.toLowerCase().indexOf(marker);
	if (idx === -1) return null;
	const SNIPPET_RADIUS = 60;
	const start = Math.max(0, idx - SNIPPET_RADIUS);
	const end = Math.min(content.length, idx + marker.length + SNIPPET_RADIUS);
	const text = content.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

export interface WikiBacklink {
	linkId: string;
	pageId: string;
	slug: string;
	title: string;
	url: string;
	snippet: string | null;
}

/**
 * Pages that link to an already-resolved+visibility-checked page, via target_page_id
 * (id-backed — a rename of the target never breaks this). Called by
 * services/wiki.ts#getWikiBacklinks after it resolves idOrSlug and checks the caller
 * can see the target page itself.
 */
export async function backlinksForResolvedPage(
	ctx: ServiceCtx,
	page: Readonly<{ id: string }>
): Promise<WikiBacklink[]> {
	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({
			linkId: schema.wikiLinks.id,
			targetTitle: schema.wikiLinks.targetTitle,
			pageId: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			content: schema.wikiPages.content,
			projectId: schema.wikiPages.projectId,
		})
		.from(schema.wikiLinks)
		.innerJoin(schema.wikiPages, eq(schema.wikiPages.id, schema.wikiLinks.sourcePageId))
		.where(
			and(
				eq(schema.wikiLinks.workspaceId, ctx.workspaceId),
				eq(schema.wikiLinks.targetPageId, page.id),
				// PROJ-496: a trashed page's outgoing links don't count as backlinks anymore.
				isNull(schema.wikiPages.deletedAt)
			)
		);

	// PROJ-311: a backlink from a project-scoped page the caller can't see shouldn't
	// leak that page's existence.
	const visibleSourceIds = new Set(
		isWorkspaceAdmin(ctx.role)
			? rows.map((r) => r.pageId)
			: await visibleSourcePageIds(
					ctx,
					rows.filter((r) => r.projectId !== null)
				)
	);
	const visible = rows.filter((r) => r.projectId === null || visibleSourceIds.has(r.pageId));

	return visible.map((r) => ({
		linkId: r.linkId,
		pageId: r.pageId,
		slug: r.slug,
		title: r.title,
		url: wikiPagePath(r.slug),
		snippet: extractSnippet(r.content, r.targetTitle),
	}));
}

// Resolves which of `rows` (all project-scoped) the caller has an effective grant on.
async function visibleSourcePageIds(
	ctx: ServiceCtx,
	rows: ReadonlyArray<{ pageId: string; projectId: string | null }>
): Promise<string[]> {
	if (rows.length === 0) return [];
	const uniqueProjectIds = [
		...new Set(rows.map((r) => r.projectId).filter((p): p is string => p !== null)),
	];
	const grantedProjectIds = new Set<string>();
	for (const projectId of uniqueProjectIds) {
		if ((await effectiveProjectRole(ctx, projectId)) !== null) grantedProjectIds.add(projectId);
	}
	return rows
		.filter((r) => r.projectId !== null && grantedProjectIds.has(r.projectId))
		.map((r) => r.pageId);
}

export interface BrokenWikiLink {
	linkId: string;
	sourcePageId: string;
	sourceSlug: string;
	sourceTitle: string;
	targetTitle: string;
}

/** All unresolved (target_page_id null) wiki_links in the workspace, optionally scoped to a project. */
export async function listBrokenWikiLinks(
	ctx: ServiceCtx,
	input: unknown
): Promise<BrokenWikiLink[]> {
	const parsed = ListBrokenWikiLinksInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	const conditions = [
		eq(schema.wikiLinks.workspaceId, ctx.workspaceId),
		// PROJ-496: a link is "broken" both when its target was hard-cleared (targetPageId
		// IS NULL, e.g. after purge) AND when its target still resolves to an id but that
		// page is now trashed — target_page_id isn't cleared until purge time anymore, so
		// without this second clause a link to a trashed-but-not-yet-purged page would
		// silently stop being reported as broken.
		or(
			isNull(schema.wikiLinks.targetPageId),
			sql`EXISTS (SELECT 1 FROM wiki_pages tp WHERE tp.id = ${schema.wikiLinks.targetPageId}
				AND tp.deleted_at IS NOT NULL)`
		),
		// PROJ-496: a trashed source page's broken links aren't a maintenance concern
		// anymore — they'll be purged along with the page.
		isNull(schema.wikiPages.deletedAt),
	];
	if (projectId) conditions.push(eq(schema.wikiPages.projectId, projectId));

	// PROJ-311: same visibility filter as listWikiPages — hide project-scoped source
	// pages the caller isn't granted, workspace-level pages stay visible to everyone.
	const visible = visibleProjectPredicate(ctx, schema.wikiPages.projectId);
	if (visible) {
		const cond = or(isNull(schema.wikiPages.projectId), visible);
		if (cond) conditions.push(cond);
	}

	const rows = await orm
		.select({
			linkId: schema.wikiLinks.id,
			sourcePageId: schema.wikiPages.id,
			sourceSlug: schema.wikiPages.slug,
			sourceTitle: schema.wikiPages.title,
			targetTitle: schema.wikiLinks.targetTitle,
		})
		.from(schema.wikiLinks)
		.innerJoin(schema.wikiPages, eq(schema.wikiPages.id, schema.wikiLinks.sourcePageId))
		.where(and(...conditions));

	return rows;
}
