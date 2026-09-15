import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createContact,
	createDeal,
	createDealLine,
	createInteraction,
	createOrganisation,
	deleteContact,
	deleteOrganisation,
	getContact,
	getDeal,
	getDealLine,
	getInteraction,
	getOrganisation,
	linkInteractionContact,
	listContactsForInteraction,
	listOrganisations,
	updateContact,
	updateDeal,
	updateDealLine,
	updateInteraction,
	updateOrganisation,
} from "../services/crm";
import { ConflictError, NotFoundError } from "../services/errors";
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

		await updateDeal(ctx, id, { stageId: "negotiation" });
		const updated = await getDeal(ctx, id);
		expect(updated.stageId).toBe("negotiation");
	});

	it("creates, reads, and updates a deal line", async () => {
		const { id: dealId } = await createDeal(ctx, { orgId, currency: "USD" });
		const { id } = await createDealLine(ctx, { dealId, qty: 2, currency: "USD", amount: 5000 });

		const line = await getDealLine(ctx, id);
		expect(line.qty).toBe(2);
		expect(line.amount).toBe(5000);

		await updateDealLine(ctx, id, { qty: 3 });
		const updated = await getDealLine(ctx, id);
		expect(updated.qty).toBe(3);
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
