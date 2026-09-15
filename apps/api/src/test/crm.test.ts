import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	anonymiseContact,
	archivePricingPlan,
	archiveProduct,
	createContact,
	createDeal,
	createInteraction,
	createOrganisation,
	createPipeline,
	createPricingPlan,
	createProduct,
	createStage,
	createTarget,
	deleteContact,
	deleteOrganisation,
	deletePricingPlan,
	deleteStage,
	deleteTarget,
	exportContact,
	getContact,
	getDeal,
	getInteraction,
	getOrganisation,
	getPipeline,
	getTarget,
	getTargetProgress,
	linkInteractionContact,
	listContactsByOrg,
	listContactsForInteraction,
	listDealLinesByDeal,
	listOrganisations,
	listPipelines,
	listStages,
	listTargets,
	moveDealStage,
	seedDefaultPipeline,
	setDealLines,
	setFxRate,
	setWorkspaceBaseCurrency,
	setWorkspaceRetentionDays,
	updateContact,
	updateDeal,
	updateInteraction,
	updateOrganisation,
	updatePipeline,
	updateTarget,
} from "../services/crm";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors";
import type { ServiceCtx } from "../services/types";
import { seedFixture } from "./helpers";

async function ctxFor(): Promise<ServiceCtx> {
	const fixture = await seedFixture();
	return {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: fixture.workspace.id,
		userId: fixture.user.id,
	};
}

describe("CRM organisations", () => {
	let ctx: ServiceCtx;

	beforeEach(async () => {
		ctx = await ctxFor();
	});

	it("creates, reads, and updates an organisation", async () => {
		const { id } = await createOrganisation(ctx, { name: "Acme Inc", domain: "acme.test" });

		const org = await getOrganisation(ctx, id);
		expect(org.name).toBe("Acme Inc");
		expect(org.domain).toBe("acme.test");

		await updateOrganisation(ctx, id, { name: "Acme Corp" });
		const updated = await getOrganisation(ctx, id);
		expect(updated.name).toBe("Acme Corp");
	});

	it("lists organisations in the workspace", async () => {
		await createOrganisation(ctx, { name: "Org A" });
		await createOrganisation(ctx, { name: "Org B" });

		const { items } = await listOrganisations(ctx);
		expect(items).toHaveLength(2);
	});

	it("blocks deletion while deals exist", async () => {
		const { id: orgId } = await createOrganisation(ctx, { name: "Has Deals" });
		await createDeal(ctx, { orgId, currency: "USD" });

		await expect(deleteOrganisation(ctx, orgId)).rejects.toBeInstanceOf(ConflictError);
	});

	it("blocks a viewer from creating an organisation", async () => {
		const viewerCtx: ServiceCtx = { ...ctx, role: "viewer" };
		await expect(createOrganisation(viewerCtx, { name: "Nope" })).rejects.toBeInstanceOf(
			ForbiddenError
		);
	});

	it("rejects creating an organisation with a domain already used in the workspace", async () => {
		await createOrganisation(ctx, { name: "First", domain: "dup.test" });
		await expect(
			createOrganisation(ctx, { name: "Second", domain: "dup.test" })
		).rejects.toBeInstanceOf(ConflictError);
	});
});

describe("CRM contacts", () => {
	let ctx: ServiceCtx;
	let orgId: string;

	beforeEach(async () => {
		ctx = await ctxFor();
		({ id: orgId } = await createOrganisation(ctx, { name: "Contact Org" }));
	});

	it("creates, reads, and updates a contact", async () => {
		const { id } = await createContact(ctx, {
			orgId,
			name: "Jane Doe",
			email: "jane@example.com",
			consentBasis: "consent",
			consentAt: Math.floor(Date.now() / 1000),
		});

		const contact = await getContact(ctx, id);
		expect(contact.name).toBe("Jane Doe");
		expect(contact.consentBasis).toBe("consent");

		await updateContact(ctx, id, { name: "Jane Smith" });
		const updated = await getContact(ctx, id);
		expect(updated.name).toBe("Jane Smith");
	});

	it("cascades interaction-contact join rows on delete, leaving the interaction intact", async () => {
		const { id: contactId } = await createContact(ctx, {
			orgId,
			name: "Cascade Contact",
			email: "cascade@example.com",
			consentBasis: "consent",
			consentAt: Math.floor(Date.now() / 1000),
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		const { id: interactionId } = await createInteraction(ctx, {
			dealId,
			type: "call",
			occurredAt: Math.floor(Date.now() / 1000),
			summary: "Intro call",
			author: ctx.userId,
		});
		await linkInteractionContact(ctx, { interactionId, contactId });

		const before = await listContactsForInteraction(ctx, interactionId);
		expect(before.items).toHaveLength(1);

		await deleteContact(ctx, contactId);

		const after = await listContactsForInteraction(ctx, interactionId);
		expect(after.items).toHaveLength(0);

		const interaction = await getInteraction(ctx, interactionId);
		expect(interaction.id).toBe(interactionId);
	});

	it("rejects linking the same contact to an interaction twice", async () => {
		const { id: contactId } = await createContact(ctx, {
			orgId,
			name: "Dup Link Contact",
			email: "duplink@example.com",
			consentBasis: "consent",
			consentAt: Math.floor(Date.now() / 1000),
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		const { id: interactionId } = await createInteraction(ctx, {
			dealId,
			type: "call",
			occurredAt: Math.floor(Date.now() / 1000),
			summary: "Intro call",
			author: ctx.userId,
		});
		await linkInteractionContact(ctx, { interactionId, contactId });

		await expect(linkInteractionContact(ctx, { interactionId, contactId })).rejects.toBeInstanceOf(
			ConflictError
		);
	});

	it("rejects creating a contact without consentBasis", async () => {
		await expect(
			createContact(ctx, {
				orgId,
				name: "No Consent",
				email: "noconsent@example.com",
				consentAt: Math.floor(Date.now() / 1000),
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("computes retentionUntil from consentBasis default retention days on create", async () => {
		const consentAt = Math.floor(Date.now() / 1000);

		const { id: contractId } = await createContact(ctx, {
			orgId,
			name: "Contract Contact",
			email: "contract@example.com",
			consentBasis: "contract",
			consentAt,
		});
		const { id: liId } = await createContact(ctx, {
			orgId,
			name: "LI Contact",
			email: "li@example.com",
			consentBasis: "legitimate_interest",
			consentAt,
		});
		const { id: consentId } = await createContact(ctx, {
			orgId,
			name: "Consent Contact",
			email: "consent@example.com",
			consentBasis: "consent",
			consentAt,
		});

		expect((await getContact(ctx, contractId)).retentionUntil).toBe(consentAt + 2555 * 86400);
		expect((await getContact(ctx, liId)).retentionUntil).toBe(consentAt + 730 * 86400);
		expect((await getContact(ctx, consentId)).retentionUntil).toBe(consentAt + 365 * 86400);
	});

	it("recomputes retentionUntil when consentBasis changes via update", async () => {
		const consentAt = Math.floor(Date.now() / 1000);
		const { id } = await createContact(ctx, {
			orgId,
			name: "Recompute Contact",
			email: "recompute@example.com",
			consentBasis: "consent",
			consentAt,
		});
		expect((await getContact(ctx, id)).retentionUntil).toBe(consentAt + 365 * 86400);

		await updateContact(ctx, id, { consentBasis: "contract" });
		expect((await getContact(ctx, id)).retentionUntil).toBe(consentAt + 2555 * 86400);
	});

	it("respects a workspace override of retention days", async () => {
		await setWorkspaceRetentionDays(ctx, { consent: 30 });
		const consentAt = Math.floor(Date.now() / 1000);
		const { id } = await createContact(ctx, {
			orgId,
			name: "Override Contact",
			email: "override@example.com",
			consentBasis: "consent",
			consentAt,
		});
		expect((await getContact(ctx, id)).retentionUntil).toBe(consentAt + 30 * 86400);
	});

	it("anonymises a contact, replacing name/email and no longer matching search by original values", async () => {
		const { id } = await createContact(ctx, {
			orgId,
			name: "Original Name",
			email: "original@example.com",
			consentBasis: "consent",
			consentAt: Math.floor(Date.now() / 1000),
		});

		await anonymiseContact(ctx, id);

		const anonymised = await getContact(ctx, id);
		expect(anonymised.name).not.toBe("Original Name");
		expect(anonymised.email).not.toBe("original@example.com");
		expect(anonymised.anonymisedAt).not.toBeNull();

		const { items } = await listContactsByOrg(ctx, orgId);
		const matches = items.filter(
			(c) => c.name === "Original Name" || c.email === "original@example.com"
		);
		expect(matches).toHaveLength(0);
	});

	it("blocks a viewer from anonymising a contact", async () => {
		const { id } = await createContact(ctx, {
			orgId,
			name: "Viewer Blocked",
			email: "viewerblocked@example.com",
			consentBasis: "consent",
			consentAt: Math.floor(Date.now() / 1000),
		});
		const viewerCtx: ServiceCtx = { ...ctx, role: "viewer" };
		await expect(anonymiseContact(viewerCtx, id)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("hard-deletes a contact without affecting the org's deals", async () => {
		const { id: contactId } = await createContact(ctx, {
			orgId,
			name: "Delete Contact",
			email: "deletecontact@example.com",
			consentBasis: "consent",
			consentAt: Math.floor(Date.now() / 1000),
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });

		await deleteContact(ctx, contactId);

		await expect(getContact(ctx, contactId)).rejects.toBeInstanceOf(NotFoundError);
		const deal = await getDeal(ctx, dealId);
		expect(deal.id).toBe(dealId);
	});

	it("exports a contact's full record, interactions, and org deals", async () => {
		const { id: contactId } = await createContact(ctx, {
			orgId,
			name: "Export Contact",
			email: "export@example.com",
			role: "CTO",
			consentBasis: "contract",
			consentAt: Math.floor(Date.now() / 1000),
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		const { id: interactionId } = await createInteraction(ctx, {
			dealId,
			type: "call",
			occurredAt: Math.floor(Date.now() / 1000),
			summary: "Export call",
			author: ctx.userId,
		});
		await linkInteractionContact(ctx, { interactionId, contactId });

		const exported = await exportContact(ctx, contactId);

		expect(exported.contact.id).toBe(contactId);
		expect(exported.contact.name).toBe("Export Contact");
		expect(exported.contact.email).toBe("export@example.com");
		expect(exported.contact.role).toBe("CTO");
		expect(exported.contact.consentBasis).toBe("contract");
		expect(exported.contact.orgId).toBe(orgId);
		expect(exported.interactions).toHaveLength(1);
		expect(exported.interactions[0]?.id).toBe(interactionId);
		expect(exported.deals).toHaveLength(1);
		expect(exported.deals[0]?.id).toBe(dealId);
	});
});

describe("CRM deals, deal lines, and interactions", () => {
	let ctx: ServiceCtx;
	let orgId: string;

	beforeEach(async () => {
		ctx = await ctxFor();
		({ id: orgId } = await createOrganisation(ctx, { name: "Deal Org" }));
	});

	it("creates, reads, and updates a deal", async () => {
		const { id } = await createDeal(ctx, { orgId, currency: "USD", valueOverride: 10000 });

		const deal = await getDeal(ctx, id);
		expect(deal.currency).toBe("USD");
		expect(deal.valueOverride).toBe(10000);

		await updateDeal(ctx, id, { valueOverride: 20000 });
		const updated = await getDeal(ctx, id);
		expect(updated.valueOverride).toBe(20000);
	});

	it("rejects updateDeal attempting to set stageId directly, requiring moveDealStage instead", async () => {
		const { id } = await createDeal(ctx, { orgId, currency: "USD" });
		await expect(updateDeal(ctx, id, { stageId: "some-stage-id" })).rejects.toBeInstanceOf(
			ValidationError
		);
	});

	it("rejects creating a deal with a pipeline from another workspace", async () => {
		const ctxB = await ctxFor();
		const { id: pipelineIdB } = await createPipeline(ctxB, { name: "Other Workspace Pipeline" });

		await expect(
			createDeal(ctx, { orgId, currency: "USD", pipelineId: pipelineIdB })
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it("rejects creating a deal whose stage doesn't belong to the given pipeline", async () => {
		const { id: pipelineA } = await createPipeline(ctx, { name: "Pipeline A" });
		const { id: pipelineB } = await createPipeline(ctx, { name: "Pipeline B" });
		const { id: stageInB } = await createStage(ctx, {
			pipelineId: pipelineB,
			name: "Stage In B",
			position: 1,
			kind: "open",
		});

		await expect(
			createDeal(ctx, { orgId, currency: "USD", pipelineId: pipelineA, stageId: stageInB })
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects updating a deal's pipelineId to one from another workspace", async () => {
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		const ctxB = await ctxFor();
		const { id: pipelineIdB } = await createPipeline(ctxB, { name: "Other Workspace Pipeline" });

		await expect(updateDeal(ctx, dealId, { pipelineId: pipelineIdB })).rejects.toBeInstanceOf(
			NotFoundError
		);
	});

	it("rejects setDealLines referencing a pricing plan from another workspace, leaving no line created", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });

		const ctxB = await ctxFor();
		const { id: productIdB } = await createProduct(ctxB, { name: "Other WS Product" });
		const { id: planIdB } = await createPricingPlan(ctxB, {
			productId: productIdB,
			name: "Other WS Plan",
			interval: "one_off",
			currency: "USD",
			amount: 500,
		});

		await expect(
			setDealLines(ctx, dealId, [{ productId: productIdB, planId: planIdB, qty: 1 }])
		).rejects.toBeInstanceOf(NotFoundError);

		const { items } = await listDealLinesByDeal(ctx, dealId);
		expect(items).toHaveLength(0);
	});

	it("rejects updateDeal attempting to set valueBase or fxRate directly, which are service-computed only", async () => {
		const { id } = await createDeal(ctx, { orgId, currency: "USD" });
		await expect(updateDeal(ctx, id, { valueBase: 100 })).rejects.toBeInstanceOf(ValidationError);
		await expect(updateDeal(ctx, id, { fxRate: 1.5 })).rejects.toBeInstanceOf(ValidationError);
	});

	it("creates, reads, and updates an interaction", async () => {
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		const { id } = await createInteraction(ctx, {
			dealId,
			type: "note",
			occurredAt: Math.floor(Date.now() / 1000),
			summary: "Left a note",
			author: ctx.userId,
		});

		const interaction = await getInteraction(ctx, id);
		expect(interaction.summary).toBe("Left a note");

		await updateInteraction(ctx, id, { summary: "Updated note" });
		const updated = await getInteraction(ctx, id);
		expect(updated.summary).toBe("Updated note");
	});
});

describe("CRM workspace scoping", () => {
	it("cross-workspace: an organisation created in workspace A is invisible from workspace B", async () => {
		const ctxA = await ctxFor();
		const ctxB = await ctxFor();

		const { id: orgId } = await createOrganisation(ctxA, { name: "Workspace A Org" });

		await expect(getOrganisation(ctxB, orgId)).rejects.toBeInstanceOf(NotFoundError);

		const { items } = await listOrganisations(ctxB);
		expect(items).toHaveLength(0);
	});
});

describe("CRM pipelines and stages", () => {
	let ctx: ServiceCtx;
	let pipelineId: string;

	beforeEach(async () => {
		ctx = await ctxFor();
		({ id: pipelineId } = await createPipeline(ctx, { name: "Test Pipeline" }));
	});

	it("creates, reads, lists, and updates a pipeline", async () => {
		const pipeline = await getPipeline(ctx, pipelineId);
		expect(pipeline.name).toBe("Test Pipeline");

		await updatePipeline(ctx, pipelineId, { name: "Renamed Pipeline" });
		const updated = await getPipeline(ctx, pipelineId);
		expect(updated.name).toBe("Renamed Pipeline");

		const { items } = await listPipelines(ctx);
		expect(items.map((p) => p.id)).toContain(pipelineId);
	});

	it("creates and lists stages in position order", async () => {
		await createStage(ctx, { pipelineId, name: "Lead", position: 1, kind: "open" });
		await createStage(ctx, { pipelineId, name: "Won", position: 2, kind: "won" });
		await createStage(ctx, { pipelineId, name: "Lost", position: 3, kind: "lost" });

		const { items } = await listStages(ctx, pipelineId);
		expect(items.map((s) => s.name)).toEqual(["Lead", "Won", "Lost"]);
	});

	it("rejects a second won stage in the same pipeline", async () => {
		await createStage(ctx, { pipelineId, name: "Won", position: 1, kind: "won" });

		await expect(
			createStage(ctx, { pipelineId, name: "Also Won", position: 2, kind: "won" })
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects deleting the only lost stage in a pipeline", async () => {
		const { id: lostId } = await createStage(ctx, {
			pipelineId,
			name: "Lost",
			position: 1,
			kind: "lost",
		});

		await expect(deleteStage(ctx, lostId)).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects a second default pipeline in the same workspace", async () => {
		await createPipeline(ctx, { name: "Default A", isDefault: true });
		await expect(
			createPipeline(ctx, { name: "Default B", isDefault: true })
		).rejects.toBeInstanceOf(ConflictError);
	});

	it("rejects creating a stage with a position already used in the same pipeline", async () => {
		await createStage(ctx, { pipelineId, name: "A", position: 1, kind: "open" });
		await expect(
			createStage(ctx, { pipelineId, name: "B", position: 1, kind: "open" })
		).rejects.toBeInstanceOf(ConflictError);
	});

	it("rejects a stage whose requiredFields names an unknown deal field", async () => {
		await expect(
			createStage(ctx, {
				pipelineId,
				name: "Weird",
				position: 1,
				kind: "open",
				requiredFields: ["notARealDealField"],
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects deleting a stage that still has deals in it", async () => {
		const { id: leadId } = await createStage(ctx, {
			pipelineId,
			name: "Lead",
			position: 1,
			kind: "open",
		});
		await createStage(ctx, { pipelineId, name: "Won", position: 2, kind: "won" });
		await createStage(ctx, { pipelineId, name: "Lost", position: 3, kind: "lost" });
		const { id: orgId } = await createOrganisation(ctx, { name: "Stage Delete Org" });
		await createDeal(ctx, { orgId, currency: "USD", pipelineId, stageId: leadId });

		await expect(deleteStage(ctx, leadId)).rejects.toBeInstanceOf(ConflictError);
	});
});

describe("CRM deal stage moves", () => {
	let ctx: ServiceCtx;
	let orgId: string;
	let pipelineId: string;
	let leadId: string;
	let qualifiedId: string;
	let wonId: string;
	let lostId: string;
	let dealId: string;

	beforeEach(async () => {
		ctx = await ctxFor();
		({ id: orgId } = await createOrganisation(ctx, { name: "Stage Move Org" }));
		({ id: pipelineId } = await createPipeline(ctx, { name: "Move Pipeline" }));
		({ id: leadId } = await createStage(ctx, {
			pipelineId,
			name: "Lead",
			position: 1,
			kind: "open",
		}));
		({ id: qualifiedId } = await createStage(ctx, {
			pipelineId,
			name: "Qualified",
			position: 2,
			kind: "open",
		}));
		({ id: wonId } = await createStage(ctx, {
			pipelineId,
			name: "Won",
			position: 3,
			kind: "won",
			requiredFields: ["ownerUserId"],
		}));
		({ id: lostId } = await createStage(ctx, {
			pipelineId,
			name: "Lost",
			position: 4,
			kind: "lost",
		}));
		({ id: dealId } = await createDeal(ctx, {
			orgId,
			currency: "USD",
			pipelineId,
			stageId: qualifiedId,
		}));
	});

	it("rejects advancing to a stage missing a required field, naming the field", async () => {
		await expect(moveDealStage(ctx, dealId, wonId, {})).rejects.toMatchObject({
			issues: { formErrors: [expect.stringContaining("ownerUserId")] },
		});
	});

	it("advances to a won stage once the required field is present and sets wonAt", async () => {
		await updateDeal(ctx, dealId, { ownerUserId: ctx.userId });

		await moveDealStage(ctx, dealId, wonId, {});

		const deal = await getDeal(ctx, dealId);
		expect(deal.stageId).toBe(wonId);
		expect(deal.wonAt).not.toBeNull();
	});

	it("rejects regressing to an earlier stage without a reason", async () => {
		await expect(moveDealStage(ctx, dealId, leadId, {})).rejects.toBeInstanceOf(ValidationError);
	});

	it("allows regressing with a reason and records it on the activity event", async () => {
		await moveDealStage(ctx, dealId, leadId, { reason: "Champion went dark" });

		const deal = await getDeal(ctx, dealId);
		expect(deal.stageId).toBe(leadId);

		const activityRow = await env.DB.prepare(
			"SELECT diff FROM activity WHERE entity_type = 'deal' AND entity_id = ? ORDER BY created_at DESC LIMIT 1"
		)
			.bind(dealId)
			.first<{ diff: string }>();
		expect(activityRow).toBeTruthy();
		const diff = JSON.parse(activityRow!.diff);
		expect(diff.toStageId).toBe(leadId);
		expect(diff.reason).toBe("Champion went dark");
	});

	it("rejects moving to a lost stage without a lostReason", async () => {
		await expect(moveDealStage(ctx, dealId, lostId, {})).rejects.toBeInstanceOf(ValidationError);
	});

	it("sets lostReason when moving to a lost stage with a reason given", async () => {
		await moveDealStage(ctx, dealId, lostId, { lostReason: "Budget cut" });

		const deal = await getDeal(ctx, dealId);
		expect(deal.stageId).toBe(lostId);
		expect(deal.lostReason).toBe("Budget cut");
	});

	it("rejects an over-length lostReason via moveDealStage's schema validation", async () => {
		await expect(
			moveDealStage(ctx, dealId, lostId, { lostReason: "x".repeat(1001) })
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("blocks a viewer from moving a deal's stage", async () => {
		const viewerCtx: ServiceCtx = { ...ctx, role: "viewer" };
		await expect(
			moveDealStage(viewerCtx, dealId, lostId, { lostReason: "x" })
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

describe("CRM default pipeline seeding", () => {
	it("is idempotent and creates the Sales pipeline with its five stages", async () => {
		const { workspace } = await seedFixture();

		await seedDefaultPipeline(env.DB, workspace.id);
		await seedDefaultPipeline(env.DB, workspace.id);

		const ctx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: workspace.id,
			userId: "",
		};
		const { items: pipelines } = await listPipelines(ctx);
		expect(pipelines).toHaveLength(1);
		expect(pipelines[0].name).toBe("Sales");
		expect(pipelines[0].isDefault).toBe(1);

		const { items: stages } = await listStages(ctx, pipelines[0].id);
		expect(stages.map((s) => s.name)).toEqual(["Lead", "Qualified", "Proposal", "Won", "Lost"]);
	});
});

describe("CRM products, pricing plans, and multi-currency deal valuation", () => {
	let ctx: ServiceCtx;
	let orgId: string;

	beforeEach(async () => {
		ctx = await ctxFor();
		({ id: orgId } = await createOrganisation(ctx, { name: "Valuation Org" }));
	});

	it("computes a deal's value_base and fx_rate from EUR-priced lines against a GBP workspace base currency", async () => {
		await setWorkspaceBaseCurrency(ctx, "GBP");
		await setFxRate(ctx, "EUR", "GBP", 0.85);

		const { id: productId } = await createProduct(ctx, { name: "Widgets" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Monthly Widgets",
			interval: "monthly",
			currency: "EUR",
			amount: 1000,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "EUR" });

		await setDealLines(ctx, dealId, [{ productId, planId, qty: 2 }]);

		const deal = await getDeal(ctx, dealId);
		expect(deal.valueBase).toBe(20400);
		expect(deal.fxRate).toBe(0.85);
	});

	it("freezes value_base and fx_rate at write time — a later setFxRate change does not retroactively alter them", async () => {
		await setWorkspaceBaseCurrency(ctx, "GBP");
		await setFxRate(ctx, "EUR", "GBP", 0.85);

		const { id: productId } = await createProduct(ctx, { name: "Widgets" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Annual Widgets",
			interval: "annual",
			currency: "EUR",
			amount: 5000,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "EUR" });

		await setDealLines(ctx, dealId, [{ productId, planId, qty: 1 }]);
		const before = await getDeal(ctx, dealId);
		expect(before.valueBase).toBe(4250);
		expect(before.fxRate).toBe(0.85);

		await setFxRate(ctx, "EUR", "GBP", 0.5);

		const after = await getDeal(ctx, dealId);
		expect(after.valueBase).toBe(4250);
		expect(after.fxRate).toBe(0.85);
	});

	it("throws a structured ValidationError, not a 0 value, when no fx rate exists for the deal/base currency pair", async () => {
		await setWorkspaceBaseCurrency(ctx, "GBP");

		const { id: productId } = await createProduct(ctx, { name: "Widgets" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "One-off Widgets",
			interval: "one_off",
			currency: "EUR",
			amount: 1000,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "EUR" });

		await expect(setDealLines(ctx, dealId, [{ productId, planId, qty: 1 }])).rejects.toBeInstanceOf(
			ValidationError
		);

		const deal = await getDeal(ctx, dealId);
		expect(deal.valueBase).toBeNull();
	});

	it("normalises a monthly plan times qty to annual in the value sum", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");

		const { id: productId } = await createProduct(ctx, { name: "SaaS Seats" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Monthly Seat",
			interval: "monthly",
			currency: "USD",
			amount: 100,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });

		await setDealLines(ctx, dealId, [{ productId, planId, qty: 3 }]);

		const deal = await getDeal(ctx, dealId);
		expect(deal.valueBase).toBe(3600);
		expect(deal.fxRate).toBe(1);
	});

	it("rejects hard-deleting a pricing plan referenced by a deal line, but allows archiving it", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");

		const { id: productId } = await createProduct(ctx, { name: "Referenced Product" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Referenced Plan",
			interval: "one_off",
			currency: "USD",
			amount: 500,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealLines(ctx, dealId, [{ productId, planId, qty: 1 }]);

		await expect(deletePricingPlan(ctx, planId)).rejects.toBeInstanceOf(ConflictError);
		await expect(archivePricingPlan(ctx, planId)).resolves.toEqual({ ok: true });
	});

	it("allows archiving a product but rejects hard-deleting one with pricing plans", async () => {
		const { id: productId } = await createProduct(ctx, { name: "Has Plans" });
		await createPricingPlan(ctx, {
			productId,
			name: "Some Plan",
			interval: "one_off",
			currency: "USD",
			amount: 100,
		});

		await expect(archiveProduct(ctx, productId)).resolves.toEqual({ ok: true });
	});

	it("leaves a deal's existing lines untouched when setDealLines fails due to a missing fx rate", async () => {
		await setWorkspaceBaseCurrency(ctx, "GBP");

		const { id: productId } = await createProduct(ctx, { name: "Widgets" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Widget Plan",
			interval: "one_off",
			currency: "EUR",
			amount: 1000,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "EUR" });

		const existingLineId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO crm_deal_lines (id, workspace_id, deal_id, product_id, plan_id, qty, currency, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
		)
			.bind(
				existingLineId,
				ctx.workspaceId,
				dealId,
				productId,
				planId,
				1,
				"EUR",
				1000,
				Math.floor(Date.now() / 1000)
			)
			.run();

		await expect(setDealLines(ctx, dealId, [{ productId, planId, qty: 2 }])).rejects.toBeInstanceOf(
			ValidationError
		);

		const { items } = await listDealLinesByDeal(ctx, dealId);
		expect(items).toHaveLength(1);
		expect(items[0].id).toBe(existingLineId);
		expect(items[0].qty).toBe(1);
	});

	it("blocks changing the workspace base currency when deals already have value_base set", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: productId } = await createProduct(ctx, { name: "Blocker Product" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Blocker Plan",
			interval: "one_off",
			currency: "USD",
			amount: 100,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealLines(ctx, dealId, [{ productId, planId, qty: 1 }]);

		await expect(setWorkspaceBaseCurrency(ctx, "GBP")).rejects.toBeInstanceOf(ConflictError);
	});

	it("allows changing the workspace base currency freely when no deals have value_base set yet", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");
		await expect(setWorkspaceBaseCurrency(ctx, "GBP")).resolves.toEqual({ ok: true });
	});

	it("rejects setDealLines with more than 50 lines", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: productId } = await createProduct(ctx, { name: "Bulk Product" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Bulk Plan",
			interval: "one_off",
			currency: "USD",
			amount: 10,
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });

		const lines = Array.from({ length: 51 }, () => ({ productId, planId, qty: 1 }));
		await expect(setDealLines(ctx, dealId, lines)).rejects.toBeInstanceOf(ValidationError);
	});
});

describe("CRM targets and progress computation", () => {
	let ctx: ServiceCtx;
	let orgId: string;
	let pipelineId: string;
	let stageId: string;

	const PERIOD_START = Math.floor(Date.UTC(2024, 5, 1) / 1000);
	const PERIOD_END_EXCLUSIVE = Math.floor(Date.UTC(2024, 6, 1) / 1000);
	const IN_WINDOW = PERIOD_START + 1000;
	const BEFORE_WINDOW = PERIOD_START - 1000;

	beforeEach(async () => {
		ctx = await ctxFor();
		({ id: orgId } = await createOrganisation(ctx, { name: "Target Org" }));
		({ id: pipelineId } = await createPipeline(ctx, { name: "Target Pipeline" }));
		({ id: stageId } = await createStage(ctx, {
			pipelineId,
			name: "Qualified",
			position: 1,
			kind: "open",
		}));
	});

	async function setDealCreatedAt(dealId: string, createdAt: number): Promise<void> {
		await env.DB.prepare("UPDATE crm_deals SET created_at = ? WHERE id = ?")
			.bind(createdAt, dealId)
			.run();
	}

	async function setLatestActivityCreatedAt(dealId: string, createdAt: number): Promise<void> {
		const row = await env.DB.prepare(
			"SELECT id FROM activity WHERE entity_type = 'deal' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
		)
			.bind(dealId)
			.first<{ id: string }>();
		await env.DB.prepare("UPDATE activity SET created_at = ? WHERE id = ?")
			.bind(createdAt, row!.id)
			.run();
	}

	it("creates, reads, lists, updates, and deletes a target", async () => {
		const { id } = await createTarget(ctx, {
			metric: "deals_created",
			period: "month",
			periodStart: PERIOD_START,
			value: 5,
		});

		const target = await getTarget(ctx, id);
		expect(target.metric).toBe("deals_created");
		expect(target.value).toBe(5);

		const { items } = await listTargets(ctx);
		expect(items).toHaveLength(1);

		await updateTarget(ctx, id, { value: 10 });
		expect((await getTarget(ctx, id)).value).toBe(10);

		await deleteTarget(ctx, id);
		await expect(getTarget(ctx, id)).rejects.toBeInstanceOf(NotFoundError);
	});

	it("computes actual deals_created within the target period", async () => {
		const { id: included } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(included, IN_WINDOW);
		const { id: excluded } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(excluded, BEFORE_WINDOW);

		const { id: targetId } = await createTarget(ctx, {
			metric: "deals_created",
			period: "month",
			periodStart: PERIOD_START,
			value: 2,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(1);
		expect(progress.percent).toBe(50);
	});

	it("computes actual deals_won within the target period", async () => {
		await createDeal(ctx, { orgId, currency: "USD", wonAt: IN_WINDOW });
		await createDeal(ctx, { orgId, currency: "USD", wonAt: BEFORE_WINDOW });
		await createDeal(ctx, { orgId, currency: "USD" });

		const { id: targetId } = await createTarget(ctx, {
			metric: "deals_won",
			period: "month",
			periodStart: PERIOD_START,
			value: 1,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(1);
	});

	it("computes actual won_value in base currency within the target period", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: dealA } = await createDeal(ctx, { orgId, currency: "USD", wonAt: IN_WINDOW });
		await updateDeal(ctx, dealA, { valueOverride: 10000 });
		const { id: dealB } = await createDeal(ctx, { orgId, currency: "USD", wonAt: IN_WINDOW });
		await updateDeal(ctx, dealB, { valueOverride: 5000 });
		const { id: dealOutside } = await createDeal(ctx, {
			orgId,
			currency: "USD",
			wonAt: BEFORE_WINDOW,
		});
		await updateDeal(ctx, dealOutside, { valueOverride: 999999 });

		const { id: targetId } = await createTarget(ctx, {
			metric: "won_value",
			period: "month",
			periodStart: PERIOD_START,
			value: 15000,
			currency: "USD",
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(15000);
		expect(progress.percent).toBe(100);
	});

	it("computes actual stage_entered from activity events moving into the target stage", async () => {
		const { id: dealA } = await createDeal(ctx, { orgId, currency: "USD", pipelineId });
		await moveDealStage(ctx, dealA, stageId, {});
		await setLatestActivityCreatedAt(dealA, IN_WINDOW);

		const { id: dealB } = await createDeal(ctx, { orgId, currency: "USD", pipelineId });
		await moveDealStage(ctx, dealB, stageId, {});
		await setLatestActivityCreatedAt(dealB, BEFORE_WINDOW);

		const { id: targetId } = await createTarget(ctx, {
			metric: "stage_entered",
			stageId,
			period: "month",
			periodStart: PERIOD_START,
			value: 1,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(1);
	});

	it("returns 0 for onboardings_completed, which is not yet computed", async () => {
		const { id: targetId } = await createTarget(ctx, {
			metric: "onboardings_completed",
			period: "month",
			periodStart: PERIOD_START,
			value: 1,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(0);
		expect(progress.percent).toBe(0);
	});

	it("includes a deal at the exact period start and excludes one at the exact period end", async () => {
		const { id: atStart } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(atStart, PERIOD_START);
		const { id: atEnd } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(atEnd, PERIOD_END_EXCLUSIVE);

		const { id: targetId } = await createTarget(ctx, {
			metric: "deals_created",
			period: "month",
			periodStart: PERIOD_START,
			value: 1,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(1);
	});

	it("rejects a stage_entered target without a stageId", async () => {
		await expect(
			createTarget(ctx, {
				metric: "stage_entered",
				period: "month",
				periodStart: PERIOD_START,
				value: 1,
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects a stage_entered target whose stageId is from another workspace", async () => {
		const ctxB = await ctxFor();
		const { id: pipelineIdB } = await createPipeline(ctxB, { name: "Other Workspace Pipeline" });
		const { id: stageIdB } = await createStage(ctxB, {
			pipelineId: pipelineIdB,
			name: "Other Stage",
			position: 1,
			kind: "open",
		});

		await expect(
			createTarget(ctx, {
				metric: "stage_entered",
				stageId: stageIdB,
				period: "month",
				periodStart: PERIOD_START,
				value: 1,
			})
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it("rejects a non-stage_entered target that carries a stageId", async () => {
		await expect(
			createTarget(ctx, {
				metric: "deals_created",
				stageId,
				period: "month",
				periodStart: PERIOD_START,
				value: 1,
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("blocks a viewer from creating a target", async () => {
		const viewerCtx: ServiceCtx = { ...ctx, role: "viewer" };
		await expect(
			createTarget(viewerCtx, {
				metric: "deals_created",
				period: "month",
				periodStart: PERIOD_START,
				value: 1,
			})
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("rejects a target with an absurd periodStart, not letting NaN propagate downstream", async () => {
		await expect(
			createTarget(ctx, {
				metric: "deals_created",
				period: "month",
				periodStart: 99999999999999,
				value: 1,
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects a target with a negative value", async () => {
		await expect(
			createTarget(ctx, {
				metric: "deals_created",
				period: "month",
				periodStart: PERIOD_START,
				value: -1,
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("clamps a month-end target period instead of overflowing into a later month", async () => {
		const periodStart = Math.floor(Date.UTC(2023, 0, 31) / 1000);
		const correctEnd = Math.floor(Date.UTC(2023, 1, 28) / 1000);
		const overflowEnd = Math.floor(Date.UTC(2023, 2, 3) / 1000);

		const { id: included } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(included, correctEnd - 1000);
		const { id: atCorrectEnd } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(atCorrectEnd, correctEnd);
		const { id: withinOldOverflowWindow } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(withinOldOverflowWindow, overflowEnd - 1000);

		const { id: targetId } = await createTarget(ctx, {
			metric: "deals_created",
			period: "month",
			periodStart,
			value: 1,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(1);
	});

	it("clamps a quarter-end target period instead of overflowing into a later month", async () => {
		const periodStart = Math.floor(Date.UTC(2023, 0, 31) / 1000);
		const correctEnd = Math.floor(Date.UTC(2023, 3, 30) / 1000);
		const overflowEnd = Math.floor(Date.UTC(2023, 4, 1) / 1000);

		const { id: included } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(included, correctEnd - 1000);
		const { id: withinOldOverflowWindow } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(withinOldOverflowWindow, overflowEnd - 1000);

		const { id: targetId } = await createTarget(ctx, {
			metric: "deals_created",
			period: "quarter",
			periodStart,
			value: 1,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(1);
	});

	it("clamps a year-end target period starting on a leap day instead of overflowing into a later month", async () => {
		const periodStart = Math.floor(Date.UTC(2024, 1, 29) / 1000);
		const correctEnd = Math.floor(Date.UTC(2025, 1, 28) / 1000);
		const overflowEnd = Math.floor(Date.UTC(2025, 2, 1) / 1000);

		const { id: included } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(included, correctEnd - 1000);
		const { id: withinOldOverflowWindow } = await createDeal(ctx, { orgId, currency: "USD" });
		await setDealCreatedAt(withinOldOverflowWindow, overflowEnd - 1000);

		const { id: targetId } = await createTarget(ctx, {
			metric: "deals_created",
			period: "year",
			periodStart,
			value: 1,
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(1);
	});

	it("counts a won deal that never went through setDealLines or a valueOverride update as 0 toward won_value (documented behaviour)", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: dealNoValuation } = await createDeal(ctx, {
			orgId,
			currency: "USD",
			wonAt: IN_WINDOW,
		});

		const { id: targetId } = await createTarget(ctx, {
			metric: "won_value",
			period: "month",
			periodStart: PERIOD_START,
			value: 1,
			currency: "USD",
		});

		const progress = await getTargetProgress(ctx, targetId);
		expect(progress.actual).toBe(0);
		expect((await getDeal(ctx, dealNoValuation)).valueBase).toBeNull();
	});

	it("clears wonAt and excludes the deal from deals_won/won_value when it regresses out of a won stage", async () => {
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: wonStageId } = await createStage(ctx, {
			pipelineId,
			name: "Won",
			position: 2,
			kind: "won",
		});
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD", pipelineId, stageId });

		await moveDealStage(ctx, dealId, wonStageId, {});
		await env.DB.prepare("UPDATE crm_deals SET won_at = ? WHERE id = ?")
			.bind(IN_WINDOW, dealId)
			.run();
		await updateDeal(ctx, dealId, { valueOverride: 5000 });

		const { id: targetWon } = await createTarget(ctx, {
			metric: "deals_won",
			period: "month",
			periodStart: PERIOD_START,
			value: 1,
		});
		const { id: targetValue } = await createTarget(ctx, {
			metric: "won_value",
			period: "month",
			periodStart: PERIOD_START,
			value: 1,
			currency: "USD",
		});
		expect((await getTargetProgress(ctx, targetWon)).actual).toBe(1);
		expect((await getTargetProgress(ctx, targetValue)).actual).toBe(5000);

		await moveDealStage(ctx, dealId, stageId, { reason: "Deal fell through after signing" });

		expect((await getDeal(ctx, dealId)).wonAt).toBeNull();
		expect((await getTargetProgress(ctx, targetWon)).actual).toBe(0);
		expect((await getTargetProgress(ctx, targetValue)).actual).toBe(0);
	});
});
