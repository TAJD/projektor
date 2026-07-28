import type { HonoEnv } from "@projektor/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { serviceErrToResponse } from "../http/error-adapter";
import * as filesService from "../services/files";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

const EntityTypeEnum = z.enum(["issue", "wiki_page"]);

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const list = await filesService.listAttachments(ctx, {
			entityType: c.req.query("entityType"),
			entityId: c.req.query("entityId"),
		});
		return c.json(list);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/links", async (c) => {
	const ctx = ctxFromHono(c);
	const body = await c.req.json().catch(() => null);
	try {
		const result = await filesService.createLinkAttachment(ctx, body);
		return c.json(result, 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
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

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);

	const formData = await parseUploadFormData(c);
	if (formData instanceof Response) return formData;

	const input = extractUploadInput(c, formData);
	if (input instanceof Response) return input;
	const { file, entityType, entityId } = input;

	try {
		await filesService.assertUploadAllowed(ctx, {
			size: file.size,
			contentType: file.type,
			quotaBytes: filesService.storageQuotaBytes(c.env),
		});
	} catch (e) {
		return serviceErrToResponse(c, e);
	}

	// cofferdam-ignore: Refactor.PreferNullishCoalescing: file.type is "" for unknown types; `||` should catch that too
	const contentType = file.type || "application/octet-stream";
	const r2Key = `${ctx.workspaceId}/${crypto.randomUUID()}`;

	// R2 object I/O is streaming-specific and stays here; metadata/quota/authz decisions
	// live in the service (PROJ-234).
	await c.env.R2.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType } });

	let id: string;
	try {
		({ id } = await filesService.recordUpload(ctx, {
			entityType,
			entityId,
			filename: file.name,
			contentType,
			size: file.size,
			r2Key,
		}));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}

	return c.json({ id, filename: file.name, contentType, size: file.size }, 201);
});

router.get("/:id", async (c) => {
	const ctx = ctxFromHono(c);
	const { id } = c.req.param();

	let meta: { r2Key: string; filename: string; contentType: string };
	try {
		meta = await filesService.getAttachmentForDownload(ctx, id);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}

	const obj = await c.env.R2.get(meta.r2Key);
	if (!obj) return c.json({ error: "Object missing from storage" }, 404);

	const safeContentType = filesService.INLINE_TYPES.has(meta.contentType)
		? meta.contentType
		: "application/octet-stream";
	const disposition = filesService.INLINE_TYPES.has(meta.contentType) ? "inline" : "attachment";
	// Strip CR/LF and quotes to prevent header injection in the filename parameter.
	const safeFilename = meta.filename.replace(/[\r\n"\\]/g, "_");

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
	const ctx = ctxFromHono(c);
	const { id } = c.req.param();

	let r2Key: string;
	try {
		({ r2Key } = await filesService.deleteAttachment(ctx, { id }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}

	if (r2Key) await c.env.R2.delete(r2Key);

	return new Response(null, { status: 204 });
});

export { router as filesRouter };
