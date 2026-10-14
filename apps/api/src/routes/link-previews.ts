import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { getLinkPreview, getLinkPreviewImage } from "../services/link-previews";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

// GET /api/link-preview?url=… — PROJ-1036. `url` is an absolute http(s) URL or an
// app-relative issue/wiki path (see schemas/link-previews.ts).
router.get("/", async (c) => {
	try {
		return c.json(await getLinkPreview(ctxFromHono(c), { url: c.req.query("url") }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// GET /api/link-preview/image?url=<page url> — PROJ-1037. The card's image, fetched by the
// Worker so the viewer's browser never contacts the linked site. REST-only: it streams
// bytes for an <img>, there's no JSON operation for an MCP tool to mirror.
router.get("/image", async (c) => {
	try {
		const image = await getLinkPreviewImage(ctxFromHono(c), { url: c.req.query("url") });
		return new Response(image.body, {
			headers: {
				"Content-Type": image.contentType,
				"Cache-Control": "private, max-age=86400",
				"Content-Security-Policy": "sandbox; default-src 'none'",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as linkPreviewsRouter };
