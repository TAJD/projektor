import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type Zippable, zipSync } from "fflate";
import { stringify as stringifyYaml } from "yaml";
import { ExportWikiInputSchema } from "../schemas/wiki";
import { effectiveProjectRole, isWorkspaceAdmin, requireProjectInWorkspace } from "./access";
import { NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

type ExportedPage = {
	id: string;
	slug: string;
	title: string;
	content: string;
};

// PROJ-311: same visibility rule as wiki.ts's assertWikiPageVisible — a workspace-level
// page (projectId null) is visible to every member; a project-scoped page needs an
// admin bypass or a group grant on that project.
async function requireSpaceVisible(ctx: ServiceCtx, projectId: string | null): Promise<void> {
	if (projectId === null) return;
	await requireProjectInWorkspace(ctx, projectId);
	if (isWorkspaceAdmin(ctx.role)) return;
	if ((await effectiveProjectRole(ctx, projectId)) === null) {
		throw new NotFoundError("Project not found");
	}
}

// Mirrors wiki.ts's resolvePageByIdOrSlug direct-match branch (no redirect chasing —
// this is an export utility, not a citation path that needs stale-link tolerance).
async function resolveExportRoot(
	ctx: ServiceCtx,
	idOrSlug: string
): Promise<{ id: string; slug: string; title: string; content: string; projectId: string | null }> {
	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			content: schema.wikiPages.content,
			projectId: schema.wikiPages.projectId,
		})
		.from(schema.wikiPages)
		.where(
			and(eq(schema.wikiPages.workspaceId, ctx.workspaceId), eq(schema.wikiPages.id, idOrSlug))
		)
		.get();
	if (row) return row;
	const bySlug = await orm
		.select({
			id: schema.wikiPages.id,
			slug: schema.wikiPages.slug,
			title: schema.wikiPages.title,
			content: schema.wikiPages.content,
			projectId: schema.wikiPages.projectId,
		})
		.from(schema.wikiPages)
		.where(
			and(eq(schema.wikiPages.workspaceId, ctx.workspaceId), eq(schema.wikiPages.slug, idOrSlug))
		)
		.get();
	if (!bySlug) throw new NotFoundError("Wiki page not found");
	return bySlug;
}

// Mirrors wiki.ts's collectDescendantIds BFS over parent_id, chunked to stay under
// D1's bound-parameter cap regardless of subtree size (see AGENTS.md's D1 limit note).
//
// wiki.ts's validateNewPageParent/validateExistingPageParent enforce "a page's parent
// must belong to the same project" on every write, so a descendant should never carry
// a different projectId than the subtree root — but that invariant lives in a file
// this domain doesn't own, so it's re-asserted here defensively rather than trusted
// blindly: any row whose projectId doesn't match the root's is dropped rather than
// exported, so a future regression of that invariant fails closed, not open.
async function collectDescendantIds(
	ctx: ServiceCtx,
	rootId: string,
	rootProjectId: string | null
): Promise<string[]> {
	const orm = drizzle(ctx.db, { schema });
	const descendants: string[] = [];
	let frontier = [rootId];
	while (frontier.length > 0) {
		const children = await inChunks(frontier, (chunk) =>
			orm
				.select({ id: schema.wikiPages.id, projectId: schema.wikiPages.projectId })
				.from(schema.wikiPages)
				.where(
					and(
						inArray(schema.wikiPages.parentId, chunk),
						eq(schema.wikiPages.workspaceId, ctx.workspaceId)
					)
				)
		);
		const inScope = children.filter((c) => (c.projectId ?? null) === rootProjectId);
		frontier = inScope.map((c) => c.id);
		descendants.push(...frontier);
	}
	return descendants;
}

async function pagesByIds(ctx: ServiceCtx, ids: string[]): Promise<ExportedPage[]> {
	const orm = drizzle(ctx.db, { schema });
	return inChunks(ids, (chunk) =>
		orm
			.select({
				id: schema.wikiPages.id,
				slug: schema.wikiPages.slug,
				title: schema.wikiPages.title,
				content: schema.wikiPages.content,
			})
			.from(schema.wikiPages)
			.where(
				and(inArray(schema.wikiPages.id, chunk), eq(schema.wikiPages.workspaceId, ctx.workspaceId))
			)
	);
}

// PROJ-488: a page's frontmatter (if any) already lives inline in `content` — that's
// the canonical source, and it round-trips through create/update/revisions untouched.
// A page with no leading `---` block gets a minimal one synthesized here (title only)
// so every exported file carries frontmatter, per the R15 spec.
function ensureFrontmatter(page: ExportedPage): string {
	if (/^---\r?\n/.test(page.content)) return page.content;
	const yamlText = stringifyYaml({ title: page.title }).trimEnd();
	return `---\n${yamlText}\n---\n${page.content}`;
}

// PROJ-426-style: only `kind: "file"` attachments carry a real R2 object (wiki_ref
// pointer attachments have an empty r2_key and nothing to zip).
async function collectAttachments(
	ctx: ServiceCtx,
	pageIds: string[]
): Promise<Array<{ pageSlug: string; filename: string; r2Key: string }>> {
	if (pageIds.length === 0) return [];
	const orm = drizzle(ctx.db, { schema });
	const bySlug = new Map<string, string>();
	for (const p of await pagesByIds(ctx, pageIds)) bySlug.set(p.id, p.slug);

	const rows = await inChunks(pageIds, (chunk) =>
		orm
			.select({
				entityId: schema.attachments.entityId,
				filename: schema.attachments.filename,
				r2Key: schema.attachments.r2Key,
			})
			.from(schema.attachments)
			.where(
				and(
					eq(schema.attachments.entityType, "wiki_page"),
					inArray(schema.attachments.entityId, chunk),
					eq(schema.attachments.kind, "file")
				)
			)
	);

	return rows
		.filter((r) => r.r2Key)
		.map((r) => ({
			pageSlug: bySlug.get(r.entityId) ?? r.entityId,
			filename: r.filename,
			r2Key: r.r2Key,
		}));
}

function safeZipPathSegment(value: string): string {
	return value.replace(/[\\/]/g, "_");
}

async function buildZip(ctx: ServiceCtx, pages: ExportedPage[]): Promise<Uint8Array> {
	const files: Zippable = {};
	const seenNames = new Map<string, number>();

	for (const page of pages) {
		const base = safeZipPathSegment(page.slug || page.id);
		let name = `pages/${base}.md`;
		const count = seenNames.get(name) ?? 0;
		seenNames.set(name, count + 1);
		if (count > 0) name = `pages/${base}-${count}.md`;
		files[name] = new TextEncoder().encode(ensureFrontmatter(page));
	}

	const attachments = await collectAttachments(
		ctx,
		pages.map((p) => p.id)
	);
	for (const att of attachments) {
		const obj = await ctx.r2.get(att.r2Key);
		if (!obj) continue; // orphaned row (object missing from storage) — skip, don't fail the export
		const bytes = new Uint8Array(await obj.arrayBuffer());
		const dir = safeZipPathSegment(att.pageSlug);
		const filename = safeZipPathSegment(att.filename);
		let name = `attachments/${dir}/${filename}`;
		const count = seenNames.get(name) ?? 0;
		seenNames.set(name, count + 1);
		if (count > 0) name = `attachments/${dir}/${count}-${filename}`;
		files[name] = bytes;
	}

	return zipSync(files);
}

export async function exportWiki(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ filename: string; bytes: Uint8Array }> {
	const parsed = ExportWikiInputSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const data = parsed.data;

	if (data.scope === "space") {
		await requireSpaceVisible(ctx, data.projectId ?? null);

		const orm = drizzle(ctx.db, { schema });
		const pages = await orm
			.select({
				id: schema.wikiPages.id,
				slug: schema.wikiPages.slug,
				title: schema.wikiPages.title,
				content: schema.wikiPages.content,
			})
			.from(schema.wikiPages)
			.where(
				and(
					eq(schema.wikiPages.workspaceId, ctx.workspaceId),
					data.projectId
						? eq(schema.wikiPages.projectId, data.projectId)
						: isNull(schema.wikiPages.projectId)
				)
			);

		const bytes = await buildZip(ctx, pages);
		const filename = data.projectId
			? `wiki-export-${data.projectId}.zip`
			: "wiki-export-workspace.zip";
		return { filename, bytes };
	}

	const root = await resolveExportRoot(ctx, data.pageId);
	await requireSpaceVisible(ctx, root.projectId);
	const descendantIds = await collectDescendantIds(ctx, root.id, root.projectId);
	const pages = await pagesByIds(ctx, [root.id, ...descendantIds]);

	const bytes = await buildZip(ctx, pages);
	return { filename: `wiki-export-${root.slug}.zip`, bytes };
}
