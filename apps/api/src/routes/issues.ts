import { serviceErrToResponse } from "../http/error-adapter";
import { operationsRouter } from "../operations/define";
import { issueOperations } from "../operations/issues";
import { listIssueLeases } from "../services/issue-leases";
import { ctxFromHono } from "../services/types";

const router = operationsRouter("/api/issues", issueOperations);

router.get("/:id/leases", async (c) => {
	const ctx = ctxFromHono(c);
	const { includeStale } = c.req.query();
	try {
		return c.json(await listIssueLeases(ctx, { issueId: c.req.param("id"), includeStale }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as issuesRouter };
