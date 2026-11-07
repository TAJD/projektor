import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { operationsRouter } from "../operations/define";
import { wikiOperations } from "../operations/wiki";
import { ctxFromHono } from "../services/types";
import { exportWiki } from "../services/wiki-export";

const router = new Hono<HonoEnv>();

// PROJ-497 (R15): must be registered before the generated /:slug route. REST-only — see
// AGENTS.md's "Deliberate REST↔MCP parity exceptions" for why (binary zip response, same
// rationale as file downloads).
router.get("/export", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const scope = c.req.query("scope");
		const projectId = c.req.query("projectId");
		const pageId = c.req.query("pageId");
		const { filename, stream } = await exportWiki(ctx, { scope, projectId, pageId });
		const safeFilename = filename.replace(/[\r\n"\\]/g, "_");
		return new Response(stream, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${safeFilename}"`,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.route("/", operationsRouter("/api/wiki", wikiOperations));

export { router as wikiRouter };
