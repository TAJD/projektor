import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Zip, ZipDeflate } from "fflate";
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

// A Worker isolate has a 128 MB memory ceiling and uploads allow up to 50 MB per file
// (MAX_UPLOAD_SIZE in services/files.ts). These caps bound export size before any R2
// fetch or zip work starts, so an oversized export fails fast with a typed error
// instead of buffering its way into an OOM/500. The streaming zip build below (buildZip)
// is the primary defense against memory blowup — these are a belt-and-braces backstop
// against pathological page counts / attachment totals.
const MAX_EXPORT_PAGES = 500;
const MAX_EXPORT_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB total per export

function assertPageCountAllowed(pageCount: number): void {
	if (pageCount > MAX_EXPORT_PAGES) {
		throw new ValidationError({
			formErrors: [`Export exceeds the ${MAX_EXPORT_PAGES}-page limit (${pageCount} pages)`],
			fieldErrors: {},
		});
	}
}

function assertExportSizeAllowed(pageCount: number, totalAttachmentBytes: number): void {
	assertPageCountAllowed(pageCount);
	if (totalAttachmentBytes > MAX_EXPORT_ATTACHMENT_BYTES) {
		throw new ValidationError({
			formErrors: [
				`Export attachments exceed the ${MAX_EXPORT_ATTACHMENT_BYTES}-byte limit (${totalAttachmentBytes} bytes)`,
			],
			fieldErrors: {},
		});
	}
}

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
		// Bail out as soon as the walk itself proves the subtree is oversized, rather than
		// continuing to accumulate ids and only rejecting after pagesByIds fetches every body.
		// +1 accounts for the root page, which isn't in `descendants`.
		assertPageCountAllowed(descendants.length + 1);
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
	pages: readonly ExportedPage[]
): Promise<Array<{ pageSlug: string; filename: string; r2Key: string; size: number }>> {
	if (pages.length === 0) return [];
	const orm = drizzle(ctx.db, { schema });
	const bySlug = new Map<string, string>();
	for (const p of pages) bySlug.set(p.id, p.slug);
	const pageIds = pages.map((p) => p.id);

	const rows = await inChunks(pageIds, (chunk) =>
		orm
			.select({
				entityId: schema.attachments.entityId,
				filename: schema.attachments.filename,
				r2Key: schema.attachments.r2Key,
				size: schema.attachments.size,
			})
			.from(schema.attachments)
			.where(
				and(
					eq(schema.attachments.workspaceId, ctx.workspaceId),
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
			size: r.size,
		}));
}

function safeZipPathSegment(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from zip names
	const stripped = value.replace(/[\\/]/g, "_").replace(/[\x00-\x1f]/g, "");
	return /^\.+$/.test(stripped) ? "_" : stripped;
}

// Keeps incrementing the collision suffix until it lands on a name nobody has used yet
// (including previously-renamed names) — a plain "rename once" scheme can produce a
// second collision (e.g. two "notes.txt" plus a real "1-notes.txt") that silently
// clobbers a file, since the zip entries are looked up by name.
function reserveUniqueName(
	usedNames: Set<string>,
	candidate: string,
	altFor: (n: number) => string
): string {
	if (!usedNames.has(candidate)) {
		usedNames.add(candidate);
		return candidate;
	}
	let n = 1;
	let alt = altFor(n);
	while (usedNames.has(alt)) {
		n += 1;
		alt = altFor(n);
	}
	usedNames.add(alt);
	return alt;
}

// Streams the archive rather than building it fully in memory: fflate's streaming Zip
// writer emits compressed chunks as each entry is pushed, so the response body never
// requires holding the complete zip (or every page/attachment at once) in memory. Only
// one attachment's bytes are held at a time, and the total attachment budget is checked
// up front (assertExportSizeAllowed) before any R2 fetch happens.
async function buildZip(
	ctx: ServiceCtx,
	pages: ExportedPage[]
): Promise<ReadableStream<Uint8Array>> {
	const attachments = await collectAttachments(ctx, pages);
	const totalAttachmentBytes = attachments.reduce((sum, a) => sum + a.size, 0);
	assertExportSizeAllowed(pages.length, totalAttachmentBytes);

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let streamErrored = false;
			const failStream = (err: unknown) => {
				if (streamErrored) return;
				streamErrored = true;
				controller.error(err);
			};

			const zip = new Zip((err, chunk, final) => {
				if (err) {
					failStream(err);
					return;
				}
				if (chunk && chunk.length > 0) controller.enqueue(chunk);
				if (final) controller.close();
			});

			try {
				const usedNames = new Set<string>();

				for (const page of pages) {
					const base = safeZipPathSegment(page.slug || page.id);
					const name = reserveUniqueName(
						usedNames,
						`pages/${base}.md`,
						(n) => `pages/${base}-${n}.md`
					);
					const entry = new ZipDeflate(name);
					zip.add(entry);
					entry.push(new TextEncoder().encode(ensureFrontmatter(page)), true);
				}

				for (const att of attachments) {
					const obj = await ctx.r2.get(att.r2Key);
					if (!obj) continue; // orphaned row (object missing from storage) — skip, don't fail the export
					const dir = safeZipPathSegment(att.pageSlug);
					const filename = safeZipPathSegment(att.filename);
					const name = reserveUniqueName(
						usedNames,
						`attachments/${dir}/${filename}`,
						(n) => `attachments/${dir}/${n}-${filename}`
					);
					const entry = new ZipDeflate(name);
					zip.add(entry);
					const bytes = new Uint8Array(await obj.arrayBuffer());
					entry.push(bytes, true);
				}

				zip.end();
			} catch (err) {
				failStream(err);
			}
		},
	});
}

export async function exportWiki(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ filename: string; stream: ReadableStream<Uint8Array> }> {
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
			)
			// Fetch one row past the cap so an oversized space can be rejected here, before
			// content bodies for the full (potentially huge) page set are ever loaded.
			.limit(MAX_EXPORT_PAGES + 1);
		assertPageCountAllowed(pages.length);

		const stream = await buildZip(ctx, pages);
		const filename = data.projectId
			? `wiki-export-${data.projectId}.zip`
			: "wiki-export-workspace.zip";
		return { filename, stream };
	}

	const root = await resolveExportRoot(ctx, data.pageId);
	await requireSpaceVisible(ctx, root.projectId);
	const descendantIds = await collectDescendantIds(ctx, root.id, root.projectId);
	const pages = await pagesByIds(ctx, [root.id, ...descendantIds]);

	const stream = await buildZip(ctx, pages);
	return { filename: `wiki-export-${root.slug}.zip`, stream };
}
