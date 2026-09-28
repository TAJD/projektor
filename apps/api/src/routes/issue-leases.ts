import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { listIssueLeases } from "../services/issue-leases";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

// PROJ-932: workspace-wide REST parity for MCP's list_issue_leases. GET /api/issues/:id/leases
// (routes/issues.ts) stays as the single-issue view; this is the equivalent of
// /api/file-claims and /api/agents for leases.
router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	const { issueId, agentId, projectId, includeStale } = c.req.query();
	try {
		return c.json(await listIssueLeases(ctx, { issueId, agentId, projectId, includeStale }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as issueLeasesRouter };
