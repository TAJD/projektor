import type { HonoEnv } from "@projektor/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { wikiPagePath } from "../lib/urls";

const router = new Hono<HonoEnv>();

const EntityTypeEnum = z.enum(["issue", "wiki_page"]);

// Only these types may render inline in the browser; everything else forces download.
// SVG is intentionally excluded (script execution risk).
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

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

const DEFAULT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB per workspace

// Resolve the per-workspace storage quota from env (STORAGE_QUOTA_BYTES), falling
// back to the default for unset/invalid/non-positive values.
function storageQuotaBytes(env: { STORAGE_QUOTA_BYTES?: string }): number {
	const n = Number(env.STORAGE_QUOTA_BYTES);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_STORAGE_QUOTA_BYTES;
}

router.get("/", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const entityType = c.req.query("entityType");
	const entityId = c.req.query("entityId");

	const parsed = EntityTypeEnum.safeParse(entityType);
	if (!parsed.success) return c.json({ error: "entityType must be issue or wiki_page" }, 400);
	if (!entityId) return c.json({ error: "entityId is required" }, 400);

	const rows = await c.env.DB.prepare(
		`SELECT a.id, a.kind, a.filename, a.content_type, a.size, a.url, a.created_at,
            w.id AS wiki_page_id, w.slug AS wiki_page_slug, w.title AS wiki_page_title,
            w.project_id AS wiki_page_project_id
     FROM attachments a
     LEFT JOIN wiki_pages w ON w.id = a.linked_wiki_page_id
     WHERE a.workspace_id = ? AND a.entity_type = ? AND a.entity_id = ?
     ORDER BY a.created_at ASC`
	)
		.bind(workspace.id, parsed.data, entityId)
		.all<{
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
		}>();

	return c.json(
		(rows.results ?? []).map((r) => ({
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
							url: wikiPagePath(r.wiki_page_slug ?? "", r.wiki_page_project_id),
						}
					: null,
		}))
	);
});

const CreateLinkAttachmentSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("wiki_ref"),
		entityType: EntityTypeEnum,
		entityId: z.string().min(1),
		wikiPageId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("url"),
		entityType: EntityTypeEnum,
		entityId: z.string().min(1),
		url: z
			.string()
			.url()
			.refine((u) => /^https?:\/\//i.test(u), "URL must be http or https"),
		label: z.string().trim().max(200).optional(),
	}),
]);

router.post("/links", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };

	const body = await c.req.json().catch(() => null);
	const parsed = CreateLinkAttachmentSchema.safeParse(body);
	if (!parsed.success)
		return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
	const input = parsed.data;

	if (input.kind === "wiki_ref") {
		const wikiPage = await c.env.DB.prepare(
			"SELECT id FROM wiki_pages WHERE id = ? AND workspace_id = ?"
		)
			.bind(input.wikiPageId, workspace.id)
			.first<{ id: string }>();
		if (!wikiPage) return c.json({ error: "Wiki page not found" }, 404);
	}

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await c.env.DB.prepare(
		`INSERT INTO attachments
       (id, workspace_id, kind, r2_key, filename, content_type, size, url, linked_wiki_page_id,
        entity_type, entity_id, created_by_id, created_at)
     VALUES (?, ?, ?, '', ?, '', 0, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			workspace.id,
			input.kind,
			input.kind === "url" ? (input.label ?? "") : "",
			input.kind === "url" ? input.url : null,
			input.kind === "wiki_ref" ? input.wikiPageId : null,
			input.entityType,
			input.entityId,
			user.id,
			now
		)
		.run();

	return c.json({ id, kind: input.kind }, 201);
});

async function parseUploadFormData(c: Context<HonoEnv>) {
	try {
		return await c.req.formData();
	} catch {
		return c.json({ error: "Expected multipart/form-data" }, 400);
	}
}

function extractUploadInput(c: Context<HonoEnv>, formData: FormData) {
	const fileRaw = formData.get("file");
	if (!fileRaw || typeof fileRaw === "string") return c.json({ error: "Missing file field" }, 400);
	const file = fileRaw as File;

	const entityTypeRaw = formData.get("entityType");
	const entityId = formData.get("entityId");

	const parsed = EntityTypeEnum.safeParse(entityTypeRaw);
	if (!parsed.success) return c.json({ error: "entityType must be issue or wiki_page" }, 400);
	if (!entityId || typeof entityId !== "string")
		return c.json({ error: "entityId is required" }, 400);

	return { file, entityType: parsed.data, entityId };
}

async function checkUploadConstraints(c: Context<HonoEnv>, workspaceId: string, file: File) {
	if (file.size > MAX_SIZE) return c.json({ error: "File too large (max 50 MB)" }, 413);

	if (!file.type || !ALLOWED_UPLOAD_TYPES.has(file.type)) {
		return c.json({ error: "File type not allowed" }, 415);
	}

	const quotaRow = await c.env.DB.prepare(
		"SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE workspace_id = ?"
	)
		.bind(workspaceId)
		.first<{ total: number }>();
	const bytesUsed = quotaRow?.total ?? 0;
	const quota = storageQuotaBytes(c.env);
	if (bytesUsed + file.size > quota) {
		const quotaMb = Math.round(quota / (1024 * 1024));
		return c.json({ error: `Workspace storage quota exceeded (${quotaMb} MB)` }, 413);
	}

	return null;
}

async function storeUpload(
	c: Context<HonoEnv>,
	params: {
		workspaceId: string;
		userId: string;
		file: File;
		entityType: z.infer<typeof EntityTypeEnum>;
		entityId: string;
	}
) {
	const id = crypto.randomUUID();
	const r2Key = `${params.workspaceId}/${id}`;
	const now = Math.floor(Date.now() / 1000);
	// cofferdam-ignore: Refactor.PreferNullishCoalescing: file.type is "" for unknown types; `||` should catch that too
	const contentType = params.file.type || "application/octet-stream";

	await c.env.R2.put(r2Key, await params.file.arrayBuffer(), {
		httpMetadata: { contentType },
	});

	await c.env.DB.prepare(
		`INSERT INTO attachments
       (id, workspace_id, r2_key, filename, content_type, size, entity_type, entity_id, created_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			params.workspaceId,
			r2Key,
			params.file.name,
			contentType,
			params.file.size,
			params.entityType,
			params.entityId,
			params.userId,
			now
		)
		.run();

	return { id, contentType };
}

router.post("/", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };

	const formData = await parseUploadFormData(c);
	if (formData instanceof Response) return formData;

	const input = extractUploadInput(c, formData);
	if (input instanceof Response) return input;
	const { file, entityType, entityId } = input;

	const constraintError = await checkUploadConstraints(c, workspace.id, file);
	if (constraintError) return constraintError;

	const { id, contentType } = await storeUpload(c, {
		workspaceId: workspace.id,
		userId: user.id,
		file,
		entityType,
		entityId,
	});

	return c.json({ id, filename: file.name, contentType, size: file.size }, 201);
});

router.get("/:id", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const { id } = c.req.param();

	const row = await c.env.DB.prepare(
		"SELECT r2_key, filename, content_type FROM attachments WHERE id = ? AND workspace_id = ?"
	)
		.bind(id, workspace.id)
		.first<{ r2_key: string; filename: string; content_type: string }>();

	if (!row) return c.json({ error: "Not found" }, 404);

	const obj = await c.env.R2.get(row.r2_key);
	if (!obj) return c.json({ error: "Object missing from storage" }, 404);

	const safeContentType = INLINE_TYPES.has(row.content_type)
		? row.content_type
		: "application/octet-stream";
	const disposition = INLINE_TYPES.has(row.content_type) ? "inline" : "attachment";
	// Strip CR/LF and quotes to prevent header injection in the filename parameter.
	const safeFilename = row.filename.replace(/[\r\n"\\]/g, "_");

	// Buffer fully so the R2 handle closes before the response is sent.
	// Streaming obj.body would leave an open handle that conflicts with miniflare's
	// per-test isolated storage cleanup and holds locks in production under backpressure.
	const body = await obj.arrayBuffer();

	return new Response(body, {
		headers: {
			"Content-Type": safeContentType,
			"Content-Disposition": `${disposition}; filename="${safeFilename}"`,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox; default-src 'none'",
		},
	});
});

router.delete("/:id", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const { id } = c.req.param();

	const row = await c.env.DB.prepare(
		"SELECT r2_key FROM attachments WHERE id = ? AND workspace_id = ?"
	)
		.bind(id, workspace.id)
		.first<{ r2_key: string }>();

	if (!row) return c.json({ error: "Not found" }, 404);

	if (row.r2_key) await c.env.R2.delete(row.r2_key);
	await c.env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();

	return new Response(null, { status: 204 });
});

export { router as filesRouter };
