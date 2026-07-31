// PROJ-493 (R11): watch/unwatch per page or subtree, a per-user notification list, and
// list_wiki_changes — cheap delta polling for agents.
//
// No dependency on services/wiki.ts (avoids a circular import — wiki.ts calls into this
// file's notifyWikiWatchers on every write). Page resolution + visibility checks are
// duplicated in miniature here rather than imported, mirroring services/wiki-links.ts's
// resolveSlugTarget precedent.
import { drizzle, schema } from "@projektor/db";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { wikiPagePath } from "../lib/urls";
import {
	ListWikiChangesInputSchema,
	ListWikiNotificationsInputSchema,
	MarkWikiNotificationsReadInputSchema,
	WatchWikiPageInputSchema,
} from "../schemas/wiki";
import { effectiveProjectRole, isWorkspaceAdmin } from "./access";
import { NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

type Orm = ReturnType<typeof drizzle<typeof schema>>;

type ResolvedWatchTarget = {
	id: string;
	slug: string;
	title: string;
	projectId: string | null;
	parentId: string | null;
};

// PROJ-493: same id-or-slug + redirect-fallback resolution as services/wiki.ts's
// resolvePageByIdOrSlug, plus the same project-visibility check as assertWikiPageVisible —
// duplicated (not imported) to avoid a circular import, see module comment above.
async function resolveWatchTarget(ctx: ServiceCtx, idOrSlug: string): Promise<ResolvedWatchTarget> {
	const orm = drizzle(ctx.db, { schema });
	const direct = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			projectId: schema.wikiPages.projectId,
			parentId: schema.wikiPages.parentId,
		})
		.from(schema.wikiPages)
		.where(
			and(
				or(eq(schema.wikiPages.id, idOrSlug), eq(schema.wikiPages.slug, idOrSlug)),
				eq(schema.wikiPages.workspaceId, ctx.workspaceId)
			)
		)
		.get();

	let page = direct;
	if (!page) {
		const redirect = await orm
			.select({ pageId: schema.wikiRedirects.pageId })
			.from(schema.wikiRedirects)
			.where(
				and(
					eq(schema.wikiRedirects.workspaceId, ctx.workspaceId),
					eq(schema.wikiRedirects.oldSlug, idOrSlug)
				)
			)
			.get();
		if (redirect) {
			page = await orm
				.select({
					id: schema.wikiPages.id,
					slug: schema.wikiPages.slug,
					title: schema.wikiPages.title,
					projectId: schema.wikiPages.projectId,
					parentId: schema.wikiPages.parentId,
				})
				.from(schema.wikiPages)
				.where(
					and(
						eq(schema.wikiPages.id, redirect.pageId),
						eq(schema.wikiPages.workspaceId, ctx.workspaceId)
					)
				)
				.get();
		}
	}
	if (!page) throw new NotFoundError("Wiki page not found");

	if (page.projectId !== null && !isWorkspaceAdmin(ctx.role)) {
		if ((await effectiveProjectRole(ctx, page.projectId)) === null) {
			throw new NotFoundError("Wiki page not found");
		}
	}
	return page;
}

export async function watchWikiPage(ctx: ServiceCtx, idOrSlug: string, input: unknown) {
	const parsed = WatchWikiPageInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const page = await resolveWatchTarget(ctx, idOrSlug);

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);
	await orm
		.insert(schema.wikiWatchers)
		.values({
			id: crypto.randomUUID(),
			workspaceId: ctx.workspaceId,
			userId: ctx.userId,
			pageId: page.id,
			subtree: parsed.data.subtree,
			createdAt: now,
		})
		.onConflictDoUpdate({
			target: [
				schema.wikiWatchers.workspaceId,
				schema.wikiWatchers.userId,
				schema.wikiWatchers.pageId,
			],
			set: { subtree: parsed.data.subtree },
		});

	return { ok: true, pageId: page.id, subtree: parsed.data.subtree, url: wikiPagePath(page.slug) };
}

export async function unwatchWikiPage(ctx: ServiceCtx, idOrSlug: string) {
	const page = await resolveWatchTarget(ctx, idOrSlug);
	const orm = drizzle(ctx.db, { schema });
	await orm
		.delete(schema.wikiWatchers)
		.where(
			and(
				eq(schema.wikiWatchers.workspaceId, ctx.workspaceId),
				eq(schema.wikiWatchers.userId, ctx.userId),
				eq(schema.wikiWatchers.pageId, page.id)
			)
		);
	return { ok: true };
}

export async function listWikiWatches(ctx: ServiceCtx) {
	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({
			id: schema.wikiWatchers.id,
			pageId: schema.wikiWatchers.pageId,
			subtree: schema.wikiWatchers.subtree,
			createdAt: schema.wikiWatchers.createdAt,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
		})
		.from(schema.wikiWatchers)
		.innerJoin(schema.wikiPages, eq(schema.wikiPages.id, schema.wikiWatchers.pageId))
		.where(
			and(
				eq(schema.wikiWatchers.workspaceId, ctx.workspaceId),
				eq(schema.wikiWatchers.userId, ctx.userId)
			)
		)
		.orderBy(desc(schema.wikiWatchers.createdAt));

	return rows.map((r) => ({ ...r, url: wikiPagePath(r.slug) }));
}

// PROJ-493: walks UP from `pageId` through parent_id, bounded by the wiki's own max
// nesting depth (5 — services/wiki.ts's validateParentDepth) plus one for headroom.
// Takes `parentId` explicitly (rather than re-reading pageId's own row) so callers can
// use it for a page that's about to be created (parentId known, pageId's row doesn't
// exist yet) or one that's mid-delete (parentId captured before the row is removed).
async function resolveAncestorChain(
	db: D1Database,
	pageId: string,
	parentId: string | null,
	workspaceId: string
): Promise<string[]> {
	const chain = [pageId];
	let cur = parentId;
	let depth = 0;
	while (cur && depth < 6) {
		chain.push(cur);
		const row = await db
			.prepare("SELECT parent_id FROM wiki_pages WHERE id = ? AND workspace_id = ?")
			.bind(cur, workspaceId)
			.first<{ parent_id: string | null }>();
		if (!row?.parent_id) break;
		cur = row.parent_id;
		depth++;
	}
	return chain;
}

const ACTION_LABEL: Record<"created" | "updated" | "deleted", string> = {
	created: "Created",
	updated: "Updated",
	deleted: "Deleted",
};

// PROJ-493: called from services/wiki.ts after every create/update/patch/delete write
// (not called at all when the affected page is currently flagged `is_template` — R9
// template pages are scaffolding, not content watchers signed up to be notified about;
// see the PR description for this reasoned call). A watch on page P matches a change to
// page X when either P === X (a direct watch, regardless of its subtree flag) or P is a
// PROPER ancestor of X and the watch has subtree=true. The actor is never notified of
// their own change.
export async function notifyWikiWatchers(
	ctx: ServiceCtx,
	opts: {
		pageId: string;
		parentId: string | null;
		slug: string;
		title: string;
		action: "created" | "updated" | "deleted";
	}
): Promise<void> {
	const ancestorIds = await resolveAncestorChain(
		ctx.db,
		opts.pageId,
		opts.parentId,
		ctx.workspaceId
	);
	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({ userId: schema.wikiWatchers.userId })
		.from(schema.wikiWatchers)
		.where(
			and(
				eq(schema.wikiWatchers.workspaceId, ctx.workspaceId),
				inArray(schema.wikiWatchers.pageId, ancestorIds),
				or(eq(schema.wikiWatchers.pageId, opts.pageId), eq(schema.wikiWatchers.subtree, true))
			)
		);

	const userIds = [...new Set(rows.map((r) => r.userId))].filter((id) => id !== ctx.userId);
	if (userIds.length === 0) return;

	await insertNotifications(
		ctx,
		orm,
		userIds.map((userId) => ({
			userId,
			pageId: opts.pageId,
			slug: opts.slug,
			title: opts.title,
			action: opts.action,
		}))
	);
}

async function insertNotifications(
	ctx: ServiceCtx,
	orm: Orm,
	entries: {
		userId: string;
		pageId: string;
		slug: string;
		title: string;
		action: "created" | "updated" | "deleted";
	}[]
): Promise<void> {
	if (entries.length === 0) return;
	const now = Math.floor(Date.now() / 1000);
	const values = entries.map((e) => ({
		id: crypto.randomUUID(),
		workspaceId: ctx.workspaceId,
		userId: e.userId,
		pageId: e.pageId,
		pageSlug: e.slug,
		pageTitle: e.title,
		action: e.action,
		actorId: ctx.userId,
		summary: `${ACTION_LABEL[e.action]}: ${e.title}`,
		createdAt: now,
		readAt: null,
	}));

	// Each row binds 11 params; 8 rows/insert stays comfortably under D1's 100-param cap
	// (services/sql.ts#inChunks is calibrated for single-param-per-item IN-lists, not
	// multi-column inserts — same rationale as wiki-links.ts's LINK_INSERT_CHUNK_SIZE).
	const NOTIFICATION_INSERT_CHUNK_SIZE = 8;
	for (let i = 0; i < values.length; i += NOTIFICATION_INSERT_CHUNK_SIZE) {
		await orm
			.insert(schema.wikiNotifications)
			.values(values.slice(i, i + NOTIFICATION_INSERT_CHUNK_SIZE));
	}
}

// PROJ-493: a cascade delete also removes every descendant page. Watchers rooted at (or
// above) the cascade root already got the single root-level notification, but a watcher
// whose watch row points AT one of the descendants matches only that descendant — without
// this they'd be told nothing at all and then have their watch row removed underneath
// them. One notification per (watcher, deleted descendant they watched).
export async function notifyCascadeDescendantWatchers(
	ctx: ServiceCtx,
	descendants: { id: string; slug: string; title: string; isTemplate: boolean }[]
): Promise<void> {
	const pages = descendants.filter((p) => !p.isTemplate);
	if (pages.length === 0) return;

	const orm = drizzle(ctx.db, { schema });
	const rows = await inChunks(
		pages.map((p) => p.id),
		(chunk) =>
			orm
				.select({ userId: schema.wikiWatchers.userId, pageId: schema.wikiWatchers.pageId })
				.from(schema.wikiWatchers)
				.where(
					and(
						eq(schema.wikiWatchers.workspaceId, ctx.workspaceId),
						inArray(schema.wikiWatchers.pageId, chunk)
					)
				)
	);

	const byId = new Map(pages.map((p) => [p.id, p]));
	const entries = rows
		.filter((r) => r.userId !== ctx.userId)
		.map((r) => {
			const page = byId.get(r.pageId);
			if (!page) return null;
			return {
				userId: r.userId,
				pageId: page.id,
				slug: page.slug,
				title: page.title,
				action: "deleted" as const,
			};
		})
		.filter((e): e is NonNullable<typeof e> => e !== null);

	await insertNotifications(ctx, orm, entries);
}

// PROJ-493: mirror wiki_watchers.page_id's ON DELETE CASCADE at the app level, same
// PROJ-407 precedent as deleteWikiPageAttachments/deleteWikiLinksForPages — D1 does not
// guarantee FK enforcement on every connection, so leaning on the FK alone would leave
// watch rows pointing at pages that no longer exist.
export async function deleteWikiWatchersForPages(
	ctx: ServiceCtx,
	pageIds: string[]
): Promise<void> {
	if (pageIds.length === 0) return;
	const orm = drizzle(ctx.db, { schema });
	await inChunks(pageIds, async (chunk) => {
		await orm
			.delete(schema.wikiWatchers)
			.where(
				and(
					eq(schema.wikiWatchers.workspaceId, ctx.workspaceId),
					inArray(schema.wikiWatchers.pageId, chunk)
				)
			);
		return [];
	});
}

export async function listWikiNotifications(ctx: ServiceCtx, input: unknown) {
	const parsed = ListWikiNotificationsInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { unreadOnly, limit, offset } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	const conditions = [
		eq(schema.wikiNotifications.workspaceId, ctx.workspaceId),
		eq(schema.wikiNotifications.userId, ctx.userId),
	];
	if (unreadOnly) conditions.push(isNull(schema.wikiNotifications.readAt));

	const rows = await orm
		.select({
			id: schema.wikiNotifications.id,
			pageId: schema.wikiNotifications.pageId,
			slug: schema.wikiNotifications.pageSlug,
			title: schema.wikiNotifications.pageTitle,
			action: schema.wikiNotifications.action,
			actorId: schema.wikiNotifications.actorId,
			summary: schema.wikiNotifications.summary,
			createdAt: schema.wikiNotifications.createdAt,
			readAt: schema.wikiNotifications.readAt,
		})
		.from(schema.wikiNotifications)
		.where(and(...conditions))
		.orderBy(desc(schema.wikiNotifications.createdAt))
		.limit(limit)
		.offset(offset);

	return rows.map((r) => ({ ...r, url: wikiPagePath(r.slug) }));
}

export async function markWikiNotificationsRead(ctx: ServiceCtx, input: unknown) {
	const parsed = MarkWikiNotificationsReadInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { ids, all } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);
	const conditions = [
		eq(schema.wikiNotifications.workspaceId, ctx.workspaceId),
		eq(schema.wikiNotifications.userId, ctx.userId),
	];
	if (!all && ids) conditions.push(inArray(schema.wikiNotifications.id, ids));

	await orm
		.update(schema.wikiNotifications)
		.set({ readAt: now })
		.where(and(...conditions));

	return { ok: true };
}

export interface WikiChangeEvent {
	id: string;
	action: "created" | "updated" | "deleted";
	pageId: string;
	slug: string | null;
	title: string | null;
	projectId: string | null;
	actorId: string | null;
	createdAt: number;
}

// PROJ-493: for created/updated events, current page state (slug/title/projectId) is
// read live off wiki_pages — always up to date even if the page changed again since.
// For deleted events there's no current row, so the same fields captured at delete time
// in the activity diff (services/wiki.ts#deleteWikiPage) are used instead — including
// projectId, which is what lets a deleted project-scoped page's event still be hidden
// from a caller who can't see that project (the workspace-scoping invariant applies to
// deleted pages too, not just live ones).
function extractDeletedPageInfo(diff: Record<string, unknown> | null): {
	slug: string | null;
	title: string | null;
	projectId: string | null;
} {
	if (!diff) return { slug: null, title: null, projectId: null };
	return {
		slug: typeof diff.slug === "string" ? diff.slug : null,
		title: typeof diff.title === "string" ? diff.title : null,
		projectId: typeof diff.projectId === "string" ? diff.projectId : null,
	};
}

// PROJ-493: resolves the (pageId -> is-watched) set for the caller, for list_wiki_changes'
// watchedOnly filter. Mirrors notifyWikiWatchers' match rule (direct watch, or a
// subtree watch on a proper ancestor) but walks the CURRENT tree — a page reparented out
// of a watched subtree since the change occurred is (deliberately) not flagged watched,
// same class of "current tree, not historical" approximation as the rest of this file.
async function watchedPageIds(
	ctx: ServiceCtx,
	orm: Orm,
	candidatePageIds: string[]
): Promise<Set<string>> {
	const watches = await orm
		.select({ pageId: schema.wikiWatchers.pageId, subtree: schema.wikiWatchers.subtree })
		.from(schema.wikiWatchers)
		.where(
			and(
				eq(schema.wikiWatchers.workspaceId, ctx.workspaceId),
				eq(schema.wikiWatchers.userId, ctx.userId)
			)
		);
	if (watches.length === 0) return new Set();

	const directWatchIds = new Set(watches.map((w) => w.pageId));
	const subtreeRootIds = new Set(watches.filter((w) => w.subtree).map((w) => w.pageId));

	const matched = new Set<string>();
	// candidate page -> the ancestor its chain walk has currently reached.
	const pending = new Map<string, string>();
	for (const pageId of new Set(candidatePageIds)) {
		if (directWatchIds.has(pageId)) {
			matched.add(pageId);
			continue;
		}
		if (subtreeRootIds.size > 0) pending.set(pageId, pageId);
	}

	// Walk every remaining candidate's parent chain in lock-step — one batched query per
	// tree level (nesting is capped at depth 5) rather than a per-candidate chain walk,
	// which would be O(candidates x depth) round-trips for a `limit` of up to 500.
	for (let depth = 0; depth < 6 && pending.size > 0; depth++) {
		const frontier = [...new Set(pending.values())];
		const rows = await inChunks(frontier, (chunk) =>
			orm
				.select({ id: schema.wikiPages.id, parentId: schema.wikiPages.parentId })
				.from(schema.wikiPages)
				.where(
					and(
						inArray(schema.wikiPages.id, chunk),
						eq(schema.wikiPages.workspaceId, ctx.workspaceId)
					)
				)
		);
		const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
		for (const [candidate, cur] of [...pending]) {
			const parent = parentOf.get(cur) ?? null;
			if (parent === null) {
				pending.delete(candidate);
			} else if (subtreeRootIds.has(parent)) {
				matched.add(candidate);
				pending.delete(candidate);
			} else {
				pending.set(candidate, parent);
			}
		}
	}
	return matched;
}

// PROJ-493 (R11): cheap delta feed — piggybacks entirely on the `activity` table every
// wiki_page write already populates (services/activity.ts#recordActivity, called from
// every create/update/patch/delete path in services/wiki.ts) rather than a separate
// change log. Defaults to every wiki page the caller can see (same visibility rule as
// list_wiki_pages/search_wiki), NOT scoped to watched pages by default — a delta-polling
// agent syncing "what changed in the wiki" is a broader use case than "what am I
// watching", and requiring a watch registration for every page an agent wants to poll
// would defeat the point of a cheap, low-ceremony polling tool. Pass watchedOnly=true to
// narrow to watched pages. Unlike notifyWikiWatchers, this does NOT exclude template
// pages — it's a ground-truth delta feed, not a notification stream, and callers that
// care can filter client-side on the page's `type`/`is_template` themselves.
export async function listWikiChanges(
	ctx: ServiceCtx,
	input: unknown
): Promise<{
	changes: WikiChangeEvent[];
	nextSince: number;
}> {
	const parsed = ListWikiChangesInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { since, limit, projectId, watchedOnly } = parsed.data;

	if (projectId) {
		if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
			return { changes: [], nextSince: since };
		}
	}

	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({
			id: schema.activity.id,
			action: schema.activity.action,
			entityId: schema.activity.entityId,
			actorId: schema.activity.actorId,
			diff: schema.activity.diff,
			createdAt: schema.activity.createdAt,
			pageSlug: schema.wikiPages.slug,
			pageTitle: schema.wikiPages.title,
			pageProjectId: schema.wikiPages.projectId,
		})
		.from(schema.activity)
		.leftJoin(schema.wikiPages, eq(schema.wikiPages.id, schema.activity.entityId))
		.where(
			and(
				eq(schema.activity.workspaceId, ctx.workspaceId),
				eq(schema.activity.entityType, "wiki_page"),
				gt(schema.activity.createdAt, since)
			)
		)
		.orderBy(schema.activity.createdAt)
		.limit(limit);

	// `since` is second-granular and exclusive, so a batch cut off mid-second by `limit`
	// would strand the rest of that second: the caller polls with nextSince = that second
	// and `gt` skips them forever. Drop the trailing partial second instead, so the next
	// poll picks it up whole. (If the WHOLE batch is one second there's nothing to trim —
	// that needs `limit` changes inside a single second, and the alternative is a poll
	// that can never advance.)
	let batch = rows;
	if (rows.length === limit && rows.length > 0) {
		const maxTs = rows[rows.length - 1].createdAt;
		if (rows[0].createdAt !== maxTs) batch = rows.filter((r) => r.createdAt < maxTs);
	}

	// One role lookup per distinct project in the batch, not per event.
	const roleCache = new Map<string, boolean>();
	const canSeeProject = async (id: string): Promise<boolean> => {
		if (isWorkspaceAdmin(ctx.role)) return true;
		const cached = roleCache.get(id);
		if (cached !== undefined) return cached;
		const visible = (await effectiveProjectRole(ctx, id)) !== null;
		roleCache.set(id, visible);
		return visible;
	};

	let nextSince = since;
	const events: WikiChangeEvent[] = [];
	for (const r of batch) {
		if (r.createdAt > nextSince) nextSince = r.createdAt;
		const action = r.action as "created" | "updated" | "deleted";
		const deleted = action === "deleted" ? extractDeletedPageInfo(r.diff) : null;
		const slug = deleted ? deleted.slug : r.pageSlug;
		const title = deleted ? deleted.title : r.pageTitle;
		const eventProjectId = deleted ? deleted.projectId : r.pageProjectId;

		if (projectId && eventProjectId !== projectId) continue;
		if (!projectId && eventProjectId !== null && !(await canSeeProject(eventProjectId))) {
			continue;
		}

		events.push({
			id: r.id,
			action,
			pageId: r.entityId,
			slug,
			title,
			projectId: eventProjectId,
			actorId: r.actorId,
			createdAt: r.createdAt,
		});
	}

	if (watchedOnly) {
		const watched = await watchedPageIds(
			ctx,
			orm,
			events.map((e) => e.pageId)
		);
		return {
			changes: events.filter((e) => watched.has(e.pageId)),
			nextSince,
		};
	}

	return { changes: events, nextSince };
}
