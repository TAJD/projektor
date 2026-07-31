import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { ctxFromHono } from "../services/types";
import * as wikiService from "../services/wiki";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const projectId = c.req.query("projectId");
		const parentId = c.req.query("parentId");
		return c.json(await wikiService.listWikiPages(ctx, { parentId, projectId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/tree", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const projectId = c.req.query("projectId");
		return c.json(await wikiService.getWikiTree(ctx, projectId));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/search", async (c) => {
	const ctx = ctxFromHono(c);
	const q = c.req.query("q") ?? "";
	const projectId = c.req.query("projectId");
	const limit = c.req.query("limit");
	const offset = c.req.query("offset");
	const updatedSince = c.req.query("updatedSince");
	try {
		return c.json(
			await wikiService.searchWiki(ctx, { query: q, projectId, limit, offset, updatedSince })
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/broken-links", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const projectId = c.req.query("projectId");
		return c.json(await wikiService.listBrokenWikiLinks(ctx, { projectId }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/backfill-links", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiService.backfillWikiLinks(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/backlinks", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiService.getWikiBacklinks(ctx, c.req.param("slug")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/revisions/:revisionId", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(
			await wikiService.getWikiRevision(ctx, c.req.param("slug"), c.req.param("revisionId"))
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/revisions", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiService.listWikiRevisions(ctx, c.req.param("slug")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiService.getWikiPage(ctx, c.req.param("slug")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await wikiService.createWikiPage(ctx, body), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.put("/:slug", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await wikiService.updateWikiPage(ctx, c.req.param("slug"), body));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const cascade = c.req.query("cascade") === "true";
		return c.json(await wikiService.deleteWikiPage(ctx, c.req.param("slug"), { cascade }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as wikiRouter };
