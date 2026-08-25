import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { workspaceMiddleware } from "../middleware/workspace";

const router = new Hono<HonoEnv>();

// GET /api/workspaces/:slug/realtime
// Opens an opt-in WebSocket connection to the workspace's Durable Object hub.
router.get("/workspaces/:slug/realtime", authMiddleware, workspaceMiddleware, async (c) => {
	if (!c.env.WORKSPACE_HUB) {
		return c.json(
			{
				error:
					"Realtime WebSockets are not enabled on this instance. Configure WORKSPACE_HUB in wrangler.toml to enable.",
			},
			501
		);
	}

	const upgradeHeader = c.req.header("Upgrade");
	if (upgradeHeader !== "websocket") {
		return c.text("Expected Upgrade: websocket", 426);
	}

	const workspace = c.get("workspace");
	const id = c.env.WORKSPACE_HUB.idFromName(workspace.id);
	const stub = c.env.WORKSPACE_HUB.get(id);

	return stub.fetch(c.req.raw);
});

// GET /api/realtime (workspace resolved via header or fallback query param)
router.get("/realtime", authMiddleware, workspaceMiddleware, async (c) => {
	if (!c.env.WORKSPACE_HUB) {
		return c.json(
			{
				error:
					"Realtime WebSockets are not enabled on this instance. Configure WORKSPACE_HUB in wrangler.toml to enable.",
			},
			501
		);
	}

	const upgradeHeader = c.req.header("Upgrade");
	if (upgradeHeader !== "websocket") {
		return c.text("Expected Upgrade: websocket", 426);
	}

	const workspace = c.get("workspace");
	const id = c.env.WORKSPACE_HUB.idFromName(workspace.id);
	const stub = c.env.WORKSPACE_HUB.get(id);

	return stub.fetch(c.req.raw);
});

export { router as realtimeRouter };
