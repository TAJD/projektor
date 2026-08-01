// PROJ-495 (R13): server-side per-user drafts, replacing the PROJ-227 localStorage
// autosave so an in-progress edit survives a device switch.
//
// No dependency on services/wiki.ts (avoids a circular import — wiki.ts calls into
// this file's deleteWikiDraftsForPages on delete). Page resolution + visibility checks
// are duplicated in miniature here rather than imported, mirroring
// services/wiki-watchers.ts's resolveWatchTarget precedent.
import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { SaveWikiDraftInputSchema } from "../schemas/wiki";
import { effectiveProjectRole, isWorkspaceAdmin } from "./access";
import { NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

type ResolvedDraftTarget = {
	id: string;
	slug: string;
};

// PROJ-495: same id-or-slug + redirect-fallback resolution as services/wiki.ts's
// resolvePageByIdOrSlug, plus the same project-visibility check — duplicated (not
// imported) to avoid a circular import, see module comment above.
async function resolveDraftTarget(ctx: ServiceCtx, idOrSlug: string): Promise<ResolvedDraftTarget> {
	const orm = drizzle(ctx.db, { schema });
	const direct = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			projectId: schema.wikiPages.projectId,
		})
		.from(schema.wikiPages)
		.where(
			and(
				or(eq(schema.wikiPages.id, idOrSlug), eq(schema.wikiPages.slug, idOrSlug)),
				eq(schema.wikiPages.workspaceId, ctx.workspaceId),
				// PROJ-496: no drafts on a trashed page — same "trashed = gone" rule as every
				// other page reference entry point (services/wiki.ts).
				isNull(schema.wikiPages.deletedAt)
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
					projectId: schema.wikiPages.projectId,
				})
				.from(schema.wikiPages)
				.where(
					and(
						eq(schema.wikiPages.id, redirect.pageId),
						eq(schema.wikiPages.workspaceId, ctx.workspaceId),
						isNull(schema.wikiPages.deletedAt)
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
	return { id: page.id, slug: page.slug };
}

// PROJ-495: returns null (not 404) when the caller has no draft for this page — "no
// draft yet" is the expected common case, not an error.
export async function getWikiDraft(ctx: ServiceCtx, idOrSlug: string) {
	const page = await resolveDraftTarget(ctx, idOrSlug);
	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({
			title: schema.wikiDrafts.title,
			content: schema.wikiDrafts.content,
			baseRevisionId: schema.wikiDrafts.baseRevisionId,
			updatedAt: schema.wikiDrafts.updatedAt,
		})
		.from(schema.wikiDrafts)
		.where(
			and(
				eq(schema.wikiDrafts.workspaceId, ctx.workspaceId),
				eq(schema.wikiDrafts.userId, ctx.userId),
				eq(schema.wikiDrafts.pageId, page.id)
			)
		)
		.get();
	return row ?? null;
}

// PROJ-495: upserts on (workspace, user, page) — a draft is scratch space, not
// history, so a later autosave just overwrites the earlier one rather than
// accumulating rows. Client-side debouncing is what keeps the call frequency
// reasonable; this endpoint does no server-side throttling of its own.
export async function saveWikiDraft(ctx: ServiceCtx, idOrSlug: string, input: unknown) {
	const parsed = SaveWikiDraftInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const page = await resolveDraftTarget(ctx, idOrSlug);

	const orm = drizzle(ctx.db, { schema });
	const now = Math.floor(Date.now() / 1000);
	await orm
		.insert(schema.wikiDrafts)
		.values({
			id: crypto.randomUUID(),
			workspaceId: ctx.workspaceId,
			userId: ctx.userId,
			pageId: page.id,
			title: parsed.data.title,
			content: parsed.data.content,
			baseRevisionId: parsed.data.baseRevisionId ?? null,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [schema.wikiDrafts.workspaceId, schema.wikiDrafts.userId, schema.wikiDrafts.pageId],
			set: {
				title: parsed.data.title,
				content: parsed.data.content,
				baseRevisionId: parsed.data.baseRevisionId ?? null,
				updatedAt: now,
			},
		});

	return { ok: true, pageId: page.id, updatedAt: now };
}

// PROJ-495: a no-op (not an error) when the caller has no draft — called both after a
// successful publish and on an explicit discard, either of which may race a second tab
// that already cleared it.
export async function discardWikiDraft(ctx: ServiceCtx, idOrSlug: string) {
	const page = await resolveDraftTarget(ctx, idOrSlug);
	const orm = drizzle(ctx.db, { schema });
	await orm
		.delete(schema.wikiDrafts)
		.where(
			and(
				eq(schema.wikiDrafts.workspaceId, ctx.workspaceId),
				eq(schema.wikiDrafts.userId, ctx.userId),
				eq(schema.wikiDrafts.pageId, page.id)
			)
		);
	return { ok: true };
}

// PROJ-495: app-level mirror of wiki_drafts.page_id's ON DELETE CASCADE, called from
// services/wiki.ts#purgeExpiredWikiPages (PROJ-496: draft cleanup moved from delete
// time to purge time) — same belt-and-braces precedent as
// wiki-watchers.ts#deleteWikiWatchersForPages (PROJ-407: D1 doesn't guarantee FK
// enforcement on every connection).
export async function deleteWikiDraftsForPages(ctx: ServiceCtx, pageIds: string[]): Promise<void> {
	if (pageIds.length === 0) return;
	const orm = drizzle(ctx.db, { schema });
	await inChunks(pageIds, async (chunk) => {
		await orm
			.delete(schema.wikiDrafts)
			.where(
				and(
					eq(schema.wikiDrafts.workspaceId, ctx.workspaceId),
					inArray(schema.wikiDrafts.pageId, chunk)
				)
			);
		return [];
	});
}
