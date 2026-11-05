import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { getToolUsage } from "../services/tool-usage";
import { ctxFromHono } from "../services/types";

// PROJ-1055: REST twin of the get_tool_usage MCP tool.
const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const { since, until, tool, limit } = c.req.query();
		return c.json(
			await getToolUsage(ctx, {
				...(since !== undefined ? { since } : {}),
				...(until !== undefined ? { until } : {}),
				...(tool !== undefined ? { tool } : {}),
				...(limit !== undefined ? { limit } : {}),
			})
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as toolUsageRouter };
