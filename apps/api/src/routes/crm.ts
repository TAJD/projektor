import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import {
	anonymiseContact,
	createContact,
	createDeal,
	createInteraction,
	createOrganisation,
	createPipeline,
	createPricingPlan,
	createProduct,
	createTarget,
	deleteContact,
	draftFollowup,
	exportContact,
	getDeal,
	getOrganisation,
	getPipelineSummary,
	getTargetProgress,
	linkDeal,
	listContactsByOrg,
	listDealsByOrg,
	listInteractionsByDeal,
	listOrganisations,
	listPipelines,
	listProducts,
	listStaleDeals,
	listTargets,
	moveDealStage,
	setDealLines,
	setFxRate,
	updateContact,
	updateDeal,
	updateOrganisation,
	updatePipeline,
} from "../services/crm";
import { ctxFromHono } from "../services/types";

const router = new Hono<HonoEnv>();

router.get("/orgs", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listOrganisations(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/orgs", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createOrganisation(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/orgs/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await getOrganisation(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/orgs/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateOrganisation(ctx, c.req.param("id"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/contacts", async (c) => {
	const ctx = ctxFromHono(c);
	const { orgId } = c.req.query();
	try {
		return c.json(await listContactsByOrg(ctx, orgId));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/contacts", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createContact(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/contacts/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateContact(ctx, c.req.param("id"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.delete("/contacts/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await deleteContact(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/contacts/:id/export", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await exportContact(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/contacts/:id/anonymise", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await anonymiseContact(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/deals", async (c) => {
	const ctx = ctxFromHono(c);
	const { orgId } = c.req.query();
	try {
		return c.json(await listDealsByOrg(ctx, orgId));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/deals/stale", async (c) => {
	const ctx = ctxFromHono(c);
	const days = c.req.query("days");
	try {
		return c.json(await listStaleDeals(ctx, { days: days ? Number(days) : undefined }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/deals", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createDeal(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/deals/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await getDeal(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/deals/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updateDeal(ctx, c.req.param("id"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.put("/deals/:id/lines", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = (await c.req.json()) as { lines?: unknown };
		return c.json(await setDealLines(ctx, c.req.param("id"), body.lines));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/deals/:id/move-stage", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = (await c.req.json()) as {
			newStageId?: string;
			reason?: string;
			lostReason?: string;
		};
		return c.json(
			await moveDealStage(ctx, c.req.param("id"), body.newStageId ?? "", {
				reason: body.reason,
				lostReason: body.lostReason,
			})
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/deals/:id/link", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await linkDeal(ctx, { ...body, dealId: c.req.param("id") }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/deals/:id/interactions", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listInteractionsByDeal(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/deals/:id/interactions", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await createInteraction(ctx, { ...body, dealId: c.req.param("id") }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/deals/:id/interactions/draft", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = await c.req.json();
		return c.json(await draftFollowup(ctx, { ...body, dealId: c.req.param("id") }), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/pipelines", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listPipelines(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/pipelines", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createPipeline(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.patch("/pipelines/:id", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await updatePipeline(ctx, c.req.param("id"), await c.req.json()));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/pipelines/:id/summary", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await getPipelineSummary(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/products", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listProducts(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/products", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createProduct(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/pricing-plans", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createPricingPlan(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/targets", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await listTargets(ctx));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/targets", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await createTarget(ctx, await c.req.json()), 201);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.get("/targets/:id/progress", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		return c.json(await getTargetProgress(ctx, c.req.param("id")));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

router.post("/fx-rates", async (c) => {
	const ctx = ctxFromHono(c);
	try {
		const body = (await c.req.json()) as {
			fromCurrency?: string;
			toCurrency?: string;
			rate?: number;
		};
		return c.json(
			await setFxRate(ctx, body.fromCurrency ?? "", body.toCurrency ?? "", body.rate ?? 0),
			201
		);
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as crmRouter };
