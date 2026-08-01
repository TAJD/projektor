import { wikiPagePath } from "../lib/urls";
import {
	CreateLinkAttachmentSchema,
	DeleteAttachmentSchema,
	GetAttachmentSchema,
	ListAttachmentsSchema,
	RecordFileUploadSchema,
} from "../schemas/files";
import { visibleProjectSqlFragment } from "./access";
import {
	ForbiddenError,
	NotFoundError,
	PayloadTooLargeError,
	UnsupportedMediaTypeError,
	ValidationError,
} from "./errors";
import type { ServiceCtx } from "./types";
import * as wikiService from "./wiki";

// PROJ-425: attachments never checked ctx.role at all — a viewer could create/delete
// them. Mirrors comments.ts's flat viewer guard rather than wiki.ts's per-project
// requireWikiWrite: attachment entityIds aren't required to reference an existing
// issue/wiki page row (they're free-floating metadata keyed by entity_type/entity_id),
// so resolving a project to check per-project role isn't possible in general.
function requireAttachmentWrite(ctx: ServiceCtx): void {
	if (ctx.role === "viewer") throw new ForbiddenError("Insufficient permissions");
}

export interface AttachmentDto {
	id: string;
	kind: "file" | "wiki_ref" | "url";
	filename: string;
	contentType: string;
	size: number;
	url: string | null;
	createdAt: number;
	wikiPage: { id: string; title: string | null; url: string } | null;
}

// Only these types may render inline in the browser; everything else forces download.
// SVG is intentionally excluded (script execution risk).
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

// file.type is supplied by the client and can be spoofed; this allowlist prevents accidental
// or casual abuse but is not a hard security boundary on its own.
const ALLOWED_UPLOAD_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/zip",
	"application/json",
]);

interface AttachmentRow {
	id: string;
	kind: "file" | "wiki_ref" | "url";
	filename: string;
	content_type: string;
	size: number;
	url: string | null;
	created_at: number;
	wiki_page_id: string | null;
	wiki_page_slug: string | null;
	wiki_page_title: string | null;
	wiki_page_project_id: string | null;
}

function toDto(r: AttachmentRow): AttachmentDto {
	return {
		id: r.id,
		kind: r.kind,
		filename: r.filename,
		contentType: r.content_type,
		size: r.size,
		url: r.url,
		createdAt: r.created_at,
		wikiPage:
			r.kind === "wiki_ref" && r.wiki_page_id
				? {
						id: r.wiki_page_id,
						title: r.wiki_page_title,
						url: wikiPagePath(r.wiki_page_slug ?? ""),
					}
				: null,
	};
}

export async function listAttachments(ctx: ServiceCtx, input: unknown): Promise<AttachmentDto[]> {
	const parsed = ListAttachmentsSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { entityType, entityId } = parsed.data;

	// PROJ-311/PROJ-407: only join in wiki page details the caller is actually allowed to
	// see (workspace-level pages, or project-scoped pages they have a grant on). A row
	// referencing a page outside the caller's visibility joins to nothing, same as a
	// deleted page — the row still lists as an unavailable wiki_ref rather than leaking
	// the restricted page's title.
	const visible = visibleProjectSqlFragment(ctx, "w.project_id");
	const joinCond = visible
		? `w.id = a.linked_wiki_page_id AND w.deleted_at IS NULL AND (w.project_id IS NULL OR ${visible.sql})`
		: "w.id = a.linked_wiki_page_id AND w.deleted_at IS NULL";

	const rows = await ctx.db
		.prepare(
			`SELECT a.id, a.kind, a.filename, a.content_type, a.size, a.url, a.created_at,
	            w.id AS wiki_page_id, w.slug AS wiki_page_slug, w.title AS wiki_page_title,
	            w.project_id AS wiki_page_project_id
	     FROM attachments a
	     LEFT JOIN wiki_pages w ON ${joinCond}
	     WHERE a.workspace_id = ? AND a.entity_type = ? AND a.entity_id = ?
	     ORDER BY a.created_at ASC`
		)
		.bind(...(visible ? visible.params : []), ctx.workspaceId, entityType, entityId)
		.all<AttachmentRow>();

	return (rows.results ?? []).map(toDto);
}

export async function createLinkAttachment(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ id: string; kind: "wiki_ref" | "url" }> {
	const parsed = CreateLinkAttachmentSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const data = parsed.data;

	requireAttachmentWrite(ctx);

	if (data.kind === "wiki_ref") {
		// PROJ-311: getWikiPage enforces project-grant visibility, not just existence —
		// a page in a project the caller can't see 404s the same as a nonexistent one.
		await wikiService.getWikiPage(ctx, data.wikiPageId);
	}

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await ctx.db
		.prepare(
			`INSERT INTO attachments
	       (id, workspace_id, kind, r2_key, filename, content_type, size, url, linked_wiki_page_id,
	        entity_type, entity_id, created_by_id, created_at)
	     VALUES (?, ?, ?, '', ?, '', 0, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			ctx.workspaceId,
			data.kind,
			data.kind === "url" ? (data.label ?? "") : "",
			data.kind === "url" ? data.url : null,
			data.kind === "wiki_ref" ? data.wikiPageId : null,
			data.entityType,
			data.entityId,
			ctx.userId,
			now
		)
		.run();

	return { id, kind: data.kind };
}

// Resolve the per-workspace storage quota from env (STORAGE_QUOTA_BYTES), falling
// back to the default for unset/invalid/non-positive values.
const DEFAULT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB per workspace

export function storageQuotaBytes(env: { STORAGE_QUOTA_BYTES?: string }): number {
	const n = Number(env.STORAGE_QUOTA_BYTES);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_STORAGE_QUOTA_BYTES;
}

async function workspaceStorageUsageBytes(ctx: ServiceCtx): Promise<number> {
	const row = await ctx.db
		.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE workspace_id = ?")
		.bind(ctx.workspaceId)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

/** Validates size/type/quota for a would-be upload; throws the matching typed error. */
export async function assertUploadAllowed(
	ctx: ServiceCtx,
	params: { size: number; contentType: string; quotaBytes?: number }
): Promise<void> {
	if (params.size > MAX_UPLOAD_SIZE) {
		throw new PayloadTooLargeError("File too large (max 50 MB)");
	}
	if (!params.contentType || !ALLOWED_UPLOAD_TYPES.has(params.contentType)) {
		throw new UnsupportedMediaTypeError("File type not allowed");
	}

	const quota = params.quotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
	const bytesUsed = await workspaceStorageUsageBytes(ctx);
	if (bytesUsed + params.size > quota) {
		const quotaMb = Math.round(quota / (1024 * 1024));
		throw new PayloadTooLargeError(`Workspace storage quota exceeded (${quotaMb} MB)`);
	}
}

/** Records metadata for a file already written to R2 by the caller (route owns R2 I/O). */
export async function recordUpload(ctx: ServiceCtx, input: unknown): Promise<{ id: string }> {
	const parsed = RecordFileUploadSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { entityType, entityId, filename, contentType, size, r2Key } = parsed.data;

	requireAttachmentWrite(ctx);

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await ctx.db
		.prepare(
			`INSERT INTO attachments
	       (id, workspace_id, r2_key, filename, content_type, size, entity_type, entity_id, created_by_id, created_at)
	     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			ctx.workspaceId,
			r2Key,
			filename,
			contentType,
			size,
			entityType,
			entityId,
			ctx.userId,
			now
		)
		.run();

	return { id };
}

/** Metadata needed to stream an attachment's bytes back; the route owns the actual R2 read. */
export async function getAttachmentForDownload(
	ctx: ServiceCtx,
	id: string
): Promise<{ r2Key: string; filename: string; contentType: string }> {
	const row = await ctx.db
		.prepare(
			"SELECT r2_key, filename, content_type FROM attachments WHERE id = ? AND workspace_id = ?"
		)
		.bind(id, ctx.workspaceId)
		.first<{ r2_key: string; filename: string; content_type: string }>();

	if (!row) throw new NotFoundError("Not found");
	return { r2Key: row.r2_key, filename: row.filename, contentType: row.content_type };
}

/** Attachment metadata in the same shape `listAttachments` returns, for the MCP get_attachment tool. */
export async function getAttachmentMetadata(
	ctx: ServiceCtx,
	input: unknown
): Promise<AttachmentDto> {
	const parsed = GetAttachmentSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const visible = visibleProjectSqlFragment(ctx, "w.project_id");
	const joinCond = visible
		? `w.id = a.linked_wiki_page_id AND w.deleted_at IS NULL AND (w.project_id IS NULL OR ${visible.sql})`
		: "w.id = a.linked_wiki_page_id AND w.deleted_at IS NULL";

	const row = await ctx.db
		.prepare(
			`SELECT a.id, a.kind, a.filename, a.content_type, a.size, a.url, a.created_at,
	            w.id AS wiki_page_id, w.slug AS wiki_page_slug, w.title AS wiki_page_title,
	            w.project_id AS wiki_page_project_id
	     FROM attachments a
	     LEFT JOIN wiki_pages w ON ${joinCond}
	     WHERE a.workspace_id = ? AND a.id = ?`
		)
		.bind(...(visible ? visible.params : []), ctx.workspaceId, parsed.data.id)
		.first<AttachmentRow>();

	if (!row) throw new NotFoundError("Not found");
	return toDto(row);
}

/** Deletes the attachment row; returns the R2 key (if any) so the route can clean up storage. */
export async function deleteAttachment(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ r2Key: string }> {
	const parsed = DeleteAttachmentSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	requireAttachmentWrite(ctx);

	const row = await ctx.db
		.prepare("SELECT r2_key FROM attachments WHERE id = ? AND workspace_id = ?")
		.bind(parsed.data.id, ctx.workspaceId)
		.first<{ r2_key: string }>();

	if (!row) throw new NotFoundError("Not found");

	await ctx.db.prepare("DELETE FROM attachments WHERE id = ?").bind(parsed.data.id).run();

	return { r2Key: row.r2_key };
}
