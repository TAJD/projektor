import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { getLinkPreview } from "../services/link-previews";
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

export { router as linkPreviewsRouter };
