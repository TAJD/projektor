import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { ctxFromHono } from "../services/types";
import * as wikiService from "../services/wiki";
import * as wikiDraftsService from "../services/wiki-drafts";
import * as wikiWatchersService from "../services/wiki-watchers";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const projectId = c.req.query("projectId");
		const parentId = c.req.query("parentId");
		const type = c.req.query("type");
		const status = c.req.query("status");
		const tags = c.req.query("tags");
		return c.json(
			await wikiService.listWikiPages(ctx, { parentId, projectId, type, status, tags })
		);
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
	const type = c.req.query("type");
	const status = c.req.query("status");
	const tags = c.req.query("tags");
	try {
		return c.json(
			await wikiService.searchWiki(ctx, {
				query: q,
				projectId,
				limit,
				offset,
				updatedSince,
				type,
				status,
				tags,
			})
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

// PROJ-489 (R7): must be registered before the /:slug catch-all below, same as
// /tree, /search, /broken-links above.
router.get("/stale-pages", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const projectId = c.req.query("projectId");
		const limit = c.req.query("limit");
		const offset = c.req.query("offset");
		return c.json(await wikiService.listStaleWikiPages(ctx, { projectId, limit, offset }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// PROJ-491 (R9): must be registered before the /:slug catch-all below, same as
// /tree, /search, /broken-links, /stale-pages above.
router.get("/templates", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const projectId = c.req.query("projectId");
		return c.json(await wikiService.listWikiTemplates(ctx, { projectId }));
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

// PROJ-493 (R11): must be registered before the /:slug catch-all below, same as every
// other fixed-path route above.
router.get("/watches", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiWatchersService.listWikiWatches(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/notifications", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const unreadOnly = c.req.query("unreadOnly");
		const limit = c.req.query("limit");
		const offset = c.req.query("offset");
		return c.json(
			await wikiWatchersService.listWikiNotifications(ctx, { unreadOnly, limit, offset })
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/notifications/read", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json().catch(() => ({}));
		return c.json(await wikiWatchersService.markWikiNotificationsRead(ctx, body));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

// PROJ-496 (R14): must be registered before the /:slug catch-all below, same as every
// other fixed-path route above.
router.get("/trash", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const projectId = c.req.query("projectId");
		const limit = c.req.query("limit");
		const offset = c.req.query("offset");
		return c.json(await wikiService.listWikiTrash(ctx, { projectId, limit, offset }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/trash/:id/undelete", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiService.undeleteWikiPage(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/purge-trash", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiService.purgeExpiredWikiPages(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/changes", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const since = c.req.query("since");
		const limit = c.req.query("limit");
		const projectId = c.req.query("projectId");
		const watchedOnly = c.req.query("watchedOnly");
		return c.json(
			await wikiWatchersService.listWikiChanges(ctx, { since, limit, projectId, watchedOnly })
		);
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

router.get("/:slug/revisions/:revisionId/diff", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(
			await wikiService.getWikiRevisionDiff(ctx, c.req.param("slug"), c.req.param("revisionId"), {
				against: c.req.query("against"),
			})
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

router.post("/:slug/verify", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiService.verifyWikiPage(ctx, c.req.param("slug")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/:slug/watch", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json().catch(() => ({}));
		return c.json(await wikiWatchersService.watchWikiPage(ctx, c.req.param("slug"), body));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/watch", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiWatchersService.unwatchWikiPage(ctx, c.req.param("slug")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/:slug/draft", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiDraftsService.getWikiDraft(ctx, c.req.param("slug")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.put("/:slug/draft", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await wikiDraftsService.saveWikiDraft(ctx, c.req.param("slug"), body));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/:slug/draft", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await wikiDraftsService.discardWikiDraft(ctx, c.req.param("slug")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/:slug", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await wikiService.patchWikiPage(ctx, c.req.param("slug"), body));
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
