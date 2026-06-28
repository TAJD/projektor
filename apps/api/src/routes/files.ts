import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { z } from "zod";

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
		"SELECT id, filename, content_type, size, created_at FROM attachments WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at ASC"
	)
		.bind(workspace.id, parsed.data, entityId)
		.all<{ id: string; filename: string; content_type: string; size: number; created_at: number }>();

	return c.json(
		(rows.results ?? []).map((r) => ({
			id: r.id,
			filename: r.filename,
			contentType: r.content_type,
			size: r.size,
			createdAt: r.created_at,
		}))
	);
});

router.post("/", async (c) => {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };

	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json({ error: "Expected multipart/form-data" }, 400);
	}

	const fileRaw = formData.get("file");
	if (!fileRaw || typeof fileRaw === "string") return c.json({ error: "Missing file field" }, 400);
	const file = fileRaw as File;

	const entityTypeRaw = formData.get("entityType");
	const entityId = formData.get("entityId");

	const parsed = EntityTypeEnum.safeParse(entityTypeRaw);
	if (!parsed.success) return c.json({ error: "entityType must be issue or wiki_page" }, 400);
	if (!entityId || typeof entityId !== "string")
		return c.json({ error: "entityId is required" }, 400);

	if (file.size > MAX_SIZE) return c.json({ error: "File too large (max 50 MB)" }, 413);

	if (!file.type || !ALLOWED_UPLOAD_TYPES.has(file.type)) {
		return c.json({ error: "File type not allowed" }, 415);
	}

	const quotaRow = await c.env.DB.prepare(
		"SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE workspace_id = ?"
	)
		.bind(workspace.id)
		.first<{ total: number }>();
	const bytesUsed = quotaRow?.total ?? 0;
	const quota = storageQuotaBytes(c.env);
	if (bytesUsed + file.size > quota) {
		const quotaMb = Math.round(quota / (1024 * 1024));
		return c.json({ error: `Workspace storage quota exceeded (${quotaMb} MB)` }, 413);
	}

	const id = crypto.randomUUID();
	const r2Key = `${workspace.id}/${id}`;
	const now = Math.floor(Date.now() / 1000);

	await c.env.R2.put(r2Key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type || "application/octet-stream" },
	});

	await c.env.DB.prepare(
		`INSERT INTO attachments (id, workspace_id, r2_key, filename, content_type, size, entity_type, entity_id, created_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			workspace.id,
			r2Key,
			file.name,
			file.type || "application/octet-stream",
			file.size,
			parsed.data,
			entityId,
			user.id,
			now
		)
		.run();

	return c.json(
		{
			id,
			filename: file.name,
			contentType: file.type || "application/octet-stream",
			size: file.size,
		},
		201
	);
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

	await c.env.R2.delete(row.r2_key);
	await c.env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();

	return new Response(null, { status: 204 });
});

export { router as filesRouter };
