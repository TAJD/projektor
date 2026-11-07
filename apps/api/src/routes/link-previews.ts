import { serviceErrToResponse } from "../http/error-adapter";
import { operationsRouter } from "../operations/define";
import { linkPreviewOperations } from "../operations/link-previews";
import { getLinkPreviewImage } from "../services/link-previews";
import { ctxFromHono } from "../services/types";

const router = operationsRouter("/api/link-preview", linkPreviewOperations);

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
