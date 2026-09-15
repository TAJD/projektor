import { drizzle, schema } from "@projektor/db";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import {
	CreateContactSchema,
	CreateDealLineSchema,
	CreateDealSchema,
	CreateInteractionSchema,
	CreateOrganisationSchema,
	LinkInteractionContactSchema,
	UpdateContactSchema,
	UpdateDealLineSchema,
	UpdateDealSchema,
	UpdateInteractionSchema,
	UpdateOrganisationSchema,
} from "../schemas/crm";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

function now(): number {
	return Math.floor(Date.now() / 1000);
}

async function requireOrganisation(ctx: ServiceCtx, orgId: string): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	const org = await orm
		.select({ id: schema.crmOrganisations.id })
		.from(schema.crmOrganisations)
		.where(
			and(
				eq(schema.crmOrganisations.id, orgId),
				eq(schema.crmOrganisations.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!org) throw new NotFoundError("Organisation not found");
}

async function requireDeal(ctx: ServiceCtx, dealId: string): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	const deal = await orm
		.select({ id: schema.crmDeals.id })
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.id, dealId), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (!deal) throw new NotFoundError("Deal not found");
}

export async function createOrganisation(ctx: ServiceCtx, raw: unknown) {
	const result = CreateOrganisationSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { name, domain, sourceRef } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	await orm.insert(schema.crmOrganisations).values({
		id,
		workspaceId: ctx.workspaceId,
		name,
		domain: domain ?? null,
		sourceRef: sourceRef ?? null,
		createdAt: ts,
		updatedAt: ts,
	});

	return { id };
}

export async function getOrganisation(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const org = await orm
		.select()
		.from(schema.crmOrganisations)
		.where(
			and(
				eq(schema.crmOrganisations.id, id),
				eq(schema.crmOrganisations.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!org) throw new NotFoundError("Organisation not found");
	return org;
}

export async function listOrganisations(ctx: ServiceCtx) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmOrganisations)
		.where(eq(schema.crmOrganisations.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.crmOrganisations.createdAt));
	return { items };
}

type OrganisationUpdateData = z.infer<typeof UpdateOrganisationSchema>;

function buildOrganisationSetData(data: OrganisationUpdateData, ts: number) {
	const setData: {
		updatedAt: number;
		name?: string;
		domain?: string | null;
		sourceRef?: string | null;
	} = { updatedAt: ts };

	if (data.name !== undefined) setData.name = data.name;
	if ("domain" in data) setData.domain = data.domain ?? null;
	if ("sourceRef" in data) setData.sourceRef = data.sourceRef ?? null;

	return setData;
}

export async function updateOrganisation(ctx: ServiceCtx, id: string, raw: unknown) {
	const result = UpdateOrganisationSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmOrganisations.id })
		.from(schema.crmOrganisations)
		.where(
			and(
				eq(schema.crmOrganisations.id, id),
				eq(schema.crmOrganisations.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!existing) throw new NotFoundError("Organisation not found");

	const setData = buildOrganisationSetData(result.data, now());
	await orm
		.update(schema.crmOrganisations)
		.set(setData)
		.where(
			and(
				eq(schema.crmOrganisations.id, id),
				eq(schema.crmOrganisations.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

export async function deleteOrganisation(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmOrganisations.id })
		.from(schema.crmOrganisations)
		.where(
			and(
				eq(schema.crmOrganisations.id, id),
				eq(schema.crmOrganisations.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!existing) throw new NotFoundError("Organisation not found");

	const deal = await orm
		.select({ id: schema.crmDeals.id })
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.orgId, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (deal) throw new ConflictError("Cannot delete organisation with existing deals");

	await orm
		.delete(schema.crmOrganisations)
		.where(
			and(
				eq(schema.crmOrganisations.id, id),
				eq(schema.crmOrganisations.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

export async function createContact(ctx: ServiceCtx, raw: unknown) {
	const result = CreateContactSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { orgId, name, email, role, consentBasis, consentAt, retentionUntil } = result.data;

	await requireOrganisation(ctx, orgId);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	await orm.insert(schema.crmContacts).values({
		id,
		workspaceId: ctx.workspaceId,
		orgId,
		name,
		email,
		role: role ?? null,
		consentBasis,
		consentAt,
		retentionUntil: retentionUntil ?? null,
		anonymisedAt: null,
		createdAt: ts,
		updatedAt: ts,
	});

	return { id };
}

export async function getContact(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const contact = await orm
		.select()
		.from(schema.crmContacts)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)))
		.get();
	if (!contact) throw new NotFoundError("Contact not found");
	return contact;
}

export async function listContactsByOrg(ctx: ServiceCtx, orgId: string) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmContacts)
		.where(
			and(eq(schema.crmContacts.orgId, orgId), eq(schema.crmContacts.workspaceId, ctx.workspaceId))
		)
		.orderBy(asc(schema.crmContacts.createdAt));
	return { items };
}

type ContactUpdateData = z.infer<typeof UpdateContactSchema>;

function buildContactSetData(data: ContactUpdateData, ts: number) {
	const setData: {
		updatedAt: number;
		name?: string;
		email?: string;
		role?: string | null;
		consentBasis?: "contract" | "legitimate_interest" | "consent";
		consentAt?: number;
		retentionUntil?: number | null;
		anonymisedAt?: number | null;
	} = { updatedAt: ts };

	if (data.name !== undefined) setData.name = data.name;
	if (data.email !== undefined) setData.email = data.email;
	if ("role" in data) setData.role = data.role ?? null;
	if (data.consentBasis !== undefined) setData.consentBasis = data.consentBasis;
	if (data.consentAt !== undefined) setData.consentAt = data.consentAt;
	if ("retentionUntil" in data) setData.retentionUntil = data.retentionUntil ?? null;
	if ("anonymisedAt" in data) setData.anonymisedAt = data.anonymisedAt ?? null;

	return setData;
}

export async function updateContact(ctx: ServiceCtx, id: string, raw: unknown) {
	const result = UpdateContactSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmContacts.id })
		.from(schema.crmContacts)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Contact not found");

	const setData = buildContactSetData(result.data, now());
	await orm
		.update(schema.crmContacts)
		.set(setData)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function deleteContact(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmContacts.id })
		.from(schema.crmContacts)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Contact not found");

	await orm
		.delete(schema.crmContacts)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function createDeal(ctx: ServiceCtx, raw: unknown) {
	const result = CreateDealSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const {
		orgId,
		pipelineId,
		stageId,
		ownerUserId,
		expectedClose,
		currency,
		valueOverride,
		fxRate,
		lostReason,
		wonAt,
	} = result.data;

	await requireOrganisation(ctx, orgId);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	await orm.insert(schema.crmDeals).values({
		id,
		workspaceId: ctx.workspaceId,
		orgId,
		pipelineId: pipelineId ?? null,
		stageId: stageId ?? null,
		ownerUserId: ownerUserId ?? null,
		expectedClose: expectedClose ?? null,
		currency,
		valueOverride: valueOverride ?? null,
		valueBase: null,
		fxRate: fxRate ?? null,
		lostReason: lostReason ?? null,
		wonAt: wonAt ?? null,
		createdAt: ts,
		updatedAt: ts,
	});

	return { id };
}

export async function getDeal(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const deal = await orm
		.select()
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.id, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (!deal) throw new NotFoundError("Deal not found");
	return deal;
}

export async function listDealsByOrg(ctx: ServiceCtx, orgId: string) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.orgId, orgId), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.orderBy(asc(schema.crmDeals.createdAt));
	return { items };
}

type DealUpdateData = z.infer<typeof UpdateDealSchema>;

function buildDealSetData(data: DealUpdateData, ts: number) {
	const setData: {
		updatedAt: number;
		pipelineId?: string | null;
		stageId?: string | null;
		ownerUserId?: string | null;
		expectedClose?: number | null;
		currency?: string;
		valueOverride?: number | null;
		valueBase?: number | null;
		fxRate?: number | null;
		lostReason?: string | null;
		wonAt?: number | null;
	} = { updatedAt: ts };

	if ("pipelineId" in data) setData.pipelineId = data.pipelineId ?? null;
	if ("stageId" in data) setData.stageId = data.stageId ?? null;
	if ("ownerUserId" in data) setData.ownerUserId = data.ownerUserId ?? null;
	if ("expectedClose" in data) setData.expectedClose = data.expectedClose ?? null;
	if (data.currency !== undefined) setData.currency = data.currency;
	if ("valueOverride" in data) setData.valueOverride = data.valueOverride ?? null;
	if ("valueBase" in data) setData.valueBase = data.valueBase ?? null;
	if ("fxRate" in data) setData.fxRate = data.fxRate ?? null;
	if ("lostReason" in data) setData.lostReason = data.lostReason ?? null;
	if ("wonAt" in data) setData.wonAt = data.wonAt ?? null;

	return setData;
}

export async function updateDeal(ctx: ServiceCtx, id: string, raw: unknown) {
	const result = UpdateDealSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmDeals.id })
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.id, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Deal not found");

	const setData = buildDealSetData(result.data, now());
	await orm
		.update(schema.crmDeals)
		.set(setData)
		.where(and(eq(schema.crmDeals.id, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function createDealLine(ctx: ServiceCtx, raw: unknown) {
	const result = CreateDealLineSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { dealId, productId, planId, qty, currency, amount } = result.data;

	await requireDeal(ctx, dealId);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();

	await orm.insert(schema.crmDealLines).values({
		id,
		workspaceId: ctx.workspaceId,
		dealId,
		productId: productId ?? null,
		planId: planId ?? null,
		qty,
		currency,
		amount,
		createdAt: now(),
	});

	return { id };
}

export async function getDealLine(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const line = await orm
		.select()
		.from(schema.crmDealLines)
		.where(
			and(eq(schema.crmDealLines.id, id), eq(schema.crmDealLines.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!line) throw new NotFoundError("Deal line not found");
	return line;
}

export async function listDealLinesByDeal(ctx: ServiceCtx, dealId: string) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmDealLines)
		.where(
			and(
				eq(schema.crmDealLines.dealId, dealId),
				eq(schema.crmDealLines.workspaceId, ctx.workspaceId)
			)
		)
		.orderBy(asc(schema.crmDealLines.createdAt));
	return { items };
}

type DealLineUpdateData = z.infer<typeof UpdateDealLineSchema>;

function buildDealLineSetData(data: DealLineUpdateData) {
	const setData: {
		productId?: string | null;
		planId?: string | null;
		qty?: number;
		currency?: string;
		amount?: number;
	} = {};

	if ("productId" in data) setData.productId = data.productId ?? null;
	if ("planId" in data) setData.planId = data.planId ?? null;
	if (data.qty !== undefined) setData.qty = data.qty;
	if (data.currency !== undefined) setData.currency = data.currency;
	if (data.amount !== undefined) setData.amount = data.amount;

	return setData;
}

export async function updateDealLine(ctx: ServiceCtx, id: string, raw: unknown) {
	const result = UpdateDealLineSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmDealLines.id })
		.from(schema.crmDealLines)
		.where(
			and(eq(schema.crmDealLines.id, id), eq(schema.crmDealLines.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!existing) throw new NotFoundError("Deal line not found");

	const setData = buildDealLineSetData(result.data);
	await orm
		.update(schema.crmDealLines)
		.set(setData)
		.where(
			and(eq(schema.crmDealLines.id, id), eq(schema.crmDealLines.workspaceId, ctx.workspaceId))
		);

	return { ok: true };
}

export async function createInteraction(ctx: ServiceCtx, raw: unknown) {
	const result = CreateInteractionSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { dealId, type, occurredAt, summary, author } = result.data;

	await requireDeal(ctx, dealId);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();

	await orm.insert(schema.crmInteractions).values({
		id,
		workspaceId: ctx.workspaceId,
		dealId,
		type,
		occurredAt,
		summary,
		author,
		createdAt: now(),
	});

	return { id };
}

export async function getInteraction(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const interaction = await orm
		.select()
		.from(schema.crmInteractions)
		.where(
			and(
				eq(schema.crmInteractions.id, id),
				eq(schema.crmInteractions.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!interaction) throw new NotFoundError("Interaction not found");
	return interaction;
}

export async function listInteractionsByDeal(ctx: ServiceCtx, dealId: string) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmInteractions)
		.where(
			and(
				eq(schema.crmInteractions.dealId, dealId),
				eq(schema.crmInteractions.workspaceId, ctx.workspaceId)
			)
		)
		.orderBy(asc(schema.crmInteractions.createdAt));
	return { items };
}

type InteractionUpdateData = z.infer<typeof UpdateInteractionSchema>;

function buildInteractionSetData(data: InteractionUpdateData) {
	const setData: {
		type?: "call" | "email" | "demo" | "note";
		occurredAt?: number;
		summary?: string;
		author?: string;
	} = {};

	if (data.type !== undefined) setData.type = data.type;
	if (data.occurredAt !== undefined) setData.occurredAt = data.occurredAt;
	if (data.summary !== undefined) setData.summary = data.summary;
	if (data.author !== undefined) setData.author = data.author;

	return setData;
}

export async function updateInteraction(ctx: ServiceCtx, id: string, raw: unknown) {
	const result = UpdateInteractionSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmInteractions.id })
		.from(schema.crmInteractions)
		.where(
			and(
				eq(schema.crmInteractions.id, id),
				eq(schema.crmInteractions.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!existing) throw new NotFoundError("Interaction not found");

	const setData = buildInteractionSetData(result.data);
	await orm
		.update(schema.crmInteractions)
		.set(setData)
		.where(
			and(
				eq(schema.crmInteractions.id, id),
				eq(schema.crmInteractions.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

export async function linkInteractionContact(ctx: ServiceCtx, raw: unknown) {
	const result = LinkInteractionContactSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { interactionId, contactId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const interaction = await orm
		.select({ id: schema.crmInteractions.id })
		.from(schema.crmInteractions)
		.where(
			and(
				eq(schema.crmInteractions.id, interactionId),
				eq(schema.crmInteractions.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!interaction) throw new NotFoundError("Interaction not found");

	const contact = await orm
		.select({ id: schema.crmContacts.id })
		.from(schema.crmContacts)
		.where(
			and(eq(schema.crmContacts.id, contactId), eq(schema.crmContacts.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!contact) throw new NotFoundError("Contact not found");

	await orm.insert(schema.crmInteractionContacts).values({ interactionId, contactId });

	return { ok: true };
}

export async function listContactsForInteraction(ctx: ServiceCtx, interactionId: string) {
	const orm = drizzle(ctx.db, { schema });
	const interaction = await orm
		.select({ id: schema.crmInteractions.id })
		.from(schema.crmInteractions)
		.where(
			and(
				eq(schema.crmInteractions.id, interactionId),
				eq(schema.crmInteractions.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!interaction) throw new NotFoundError("Interaction not found");

	const items = await orm
		.select({ contactId: schema.crmInteractionContacts.contactId })
		.from(schema.crmInteractionContacts)
		.where(eq(schema.crmInteractionContacts.interactionId, interactionId));

	return { items };
}
