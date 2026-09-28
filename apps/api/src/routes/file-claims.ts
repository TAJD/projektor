import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { jsonBody } from "../http/body";
import { serviceErrToResponse } from "../http/error-adapter";
import { claimFiles, listFileClaims, releaseFiles } from "../services/file-claims";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	const { issueId, path, projectId, includeStale } = c.req.query();
	try {
		return c.json(await listFileClaims(ctx, { issueId, path, projectId, includeStale }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await claimFiles(ctx, await jsonBody(c)), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/release", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await releaseFiles(ctx, await jsonBody(c)));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as fileClaimsRouter };
