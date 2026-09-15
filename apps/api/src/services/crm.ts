import { drizzle, schema } from "@projektor/db";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import {
	CreateContactSchema,
	CreateDealLineSchema,
	CreateDealSchema,
	CreateInteractionSchema,
	CreateOrganisationSchema,
	CreatePipelineSchema,
	CreateStageSchema,
	LinkInteractionContactSchema,
	MoveDealStageSchema,
	UpdateContactSchema,
	UpdateDealLineSchema,
	UpdateDealSchema,
	UpdateInteractionSchema,
	UpdateOrganisationSchema,
	UpdatePipelineSchema,
	UpdateStageSchema,
} from "../schemas/crm";
import { recordActivity } from "./activity";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

function now(): number {
	return Math.floor(Date.now() / 1000);
}

function assertCanMutate(ctx: ServiceCtx): void {
	if (ctx.role === "viewer") throw new ForbiddenError("Insufficient permissions");
}

function isUniqueConstraintError(e: unknown): boolean {
	let cur: unknown = e;
	for (let i = 0; i < 5 && cur instanceof Error; i++) {
		if (/UNIQUE constraint failed/i.test(cur.message)) return true;
		cur = cur.cause;
	}
	return false;
}

const DEAL_FIELD_ALLOWLIST = new Set([
	"orgId",
	"pipelineId",
	"stageId",
	"ownerUserId",
	"expectedClose",
	"currency",
	"valueOverride",
	"valueBase",
	"fxRate",
	"lostReason",
	"wonAt",
]);

function assertRequiredFieldsKnown(fields: readonly string[]): void {
	const unknown = fields.filter((f) => !DEAL_FIELD_ALLOWLIST.has(f));
	if (unknown.length > 0) {
		throw new ValidationError({
			formErrors: [`Unknown deal field(s) in requiredFields: ${unknown.join(", ")}`],
			fieldErrors: {},
		});
	}
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
	assertCanMutate(ctx);
	const result = CreateOrganisationSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { name, domain, sourceRef } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	try {
		await orm.insert(schema.crmOrganisations).values({
			id,
			workspaceId: ctx.workspaceId,
			name,
			domain: domain ?? null,
			sourceRef: sourceRef ?? null,
			createdAt: ts,
			updatedAt: ts,
		});
	} catch (e) {
		if (isUniqueConstraintError(e)) {
			throw new ConflictError(`Domain '${domain}' is already in use`);
		}
		throw e;
	}

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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	await assertPipelineStageConsistent(ctx, pipelineId, stageId);

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
		ownerUserId?: string | null;
		expectedClose?: number | null;
		currency?: string;
		valueOverride?: number | null;
		valueBase?: number | null;
		fxRate?: number | null;
	} = { updatedAt: ts };

	if ("pipelineId" in data) setData.pipelineId = data.pipelineId ?? null;
	if ("ownerUserId" in data) setData.ownerUserId = data.ownerUserId ?? null;
	if ("expectedClose" in data) setData.expectedClose = data.expectedClose ?? null;
	if (data.currency !== undefined) setData.currency = data.currency;
	if ("valueOverride" in data) setData.valueOverride = data.valueOverride ?? null;
	if ("valueBase" in data) setData.valueBase = data.valueBase ?? null;
	if ("fxRate" in data) setData.fxRate = data.fxRate ?? null;

	return setData;
}

export async function updateDeal(ctx: ServiceCtx, id: string, raw: unknown) {
	assertCanMutate(ctx);
	if (
		raw &&
		typeof raw === "object" &&
		("stageId" in raw || "wonAt" in raw || "lostReason" in raw)
	) {
		throw new ValidationError({
			formErrors: [
				"stageId, wonAt, and lostReason cannot be set via updateDeal — use moveDealStage instead",
			],
			fieldErrors: {},
		});
	}

	const result = UpdateDealSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.crmDeals.id })
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.id, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Deal not found");

	if ("pipelineId" in result.data && result.data.pipelineId) {
		await requirePipeline(ctx, result.data.pipelineId);
	}

	const setData = buildDealSetData(result.data, now());
	await orm
		.update(schema.crmDeals)
		.set(setData)
		.where(and(eq(schema.crmDeals.id, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function createDealLine(ctx: ServiceCtx, raw: unknown) {
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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
	assertCanMutate(ctx);
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

	try {
		await orm.insert(schema.crmInteractionContacts).values({ interactionId, contactId });
	} catch (e) {
		if (isUniqueConstraintError(e)) {
			throw new ConflictError("Contact is already linked to this interaction");
		}
		throw e;
	}

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

async function requirePipeline(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const pipeline = await orm
		.select()
		.from(schema.crmPipelines)
		.where(
			and(eq(schema.crmPipelines.id, id), eq(schema.crmPipelines.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!pipeline) throw new NotFoundError("Pipeline not found");
	return pipeline;
}

async function requireStageRow(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const stage = await orm
		.select()
		.from(schema.crmStages)
		.where(and(eq(schema.crmStages.id, id), eq(schema.crmStages.workspaceId, ctx.workspaceId)))
		.get();
	if (!stage) throw new NotFoundError("Stage not found");
	return stage;
}

async function assertPipelineStageConsistent(
	ctx: ServiceCtx,
	pipelineId: string | undefined,
	stageId: string | undefined
): Promise<void> {
	if (pipelineId) await requirePipeline(ctx, pipelineId);
	if (stageId) {
		const stage = await requireStageRow(ctx, stageId);
		if (pipelineId && stage.pipelineId !== pipelineId) {
			throw new ValidationError({
				formErrors: ["stageId does not belong to the given pipelineId"],
				fieldErrors: {},
			});
		}
	}
}

async function listPipelineStageKinds(
	ctx: ServiceCtx,
	pipelineId: string
): Promise<{ id: string; kind: "open" | "won" | "lost" }[]> {
	const orm = drizzle(ctx.db, { schema });
	return orm
		.select({ id: schema.crmStages.id, kind: schema.crmStages.kind })
		.from(schema.crmStages)
		.where(
			and(
				eq(schema.crmStages.pipelineId, pipelineId),
				eq(schema.crmStages.workspaceId, ctx.workspaceId)
			)
		);
}

function countWonLost(stages: readonly { kind: "open" | "won" | "lost" }[]) {
	let won = 0;
	let lost = 0;
	for (const s of stages) {
		if (s.kind === "won") won++;
		if (s.kind === "lost") lost++;
	}
	return { won, lost };
}

function assertWonLostInvariant(
	before: readonly { kind: "open" | "won" | "lost" }[],
	after: readonly { kind: "open" | "won" | "lost" }[]
) {
	const b = countWonLost(before);
	const a = countWonLost(after);
	if (a.won > 1) {
		throw new ValidationError({
			formErrors: ["A pipeline may have at most one won stage"],
			fieldErrors: {},
		});
	}
	if (b.won >= 1 && a.won === 0) {
		throw new ValidationError({
			formErrors: ["A pipeline must retain exactly one won stage"],
			fieldErrors: {},
		});
	}
	if (b.lost >= 1 && a.lost === 0) {
		throw new ValidationError({
			formErrors: ["A pipeline must retain at least one lost stage"],
			fieldErrors: {},
		});
	}
}

export async function createPipeline(ctx: ServiceCtx, raw: unknown) {
	assertCanMutate(ctx);
	const result = CreatePipelineSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { name, defaultOnboardingTemplate, isDefault } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	try {
		await orm.insert(schema.crmPipelines).values({
			id,
			workspaceId: ctx.workspaceId,
			name,
			defaultOnboardingTemplate: defaultOnboardingTemplate ?? null,
			isDefault: isDefault ? 1 : 0,
			createdAt: ts,
			updatedAt: ts,
		});
	} catch (e) {
		if (isUniqueConstraintError(e)) {
			throw new ConflictError("Only one default pipeline is allowed per workspace");
		}
		throw e;
	}

	return { id };
}

export async function getPipeline(ctx: ServiceCtx, id: string) {
	return requirePipeline(ctx, id);
}

export async function listPipelines(ctx: ServiceCtx) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmPipelines)
		.where(eq(schema.crmPipelines.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.crmPipelines.createdAt));
	return { items };
}

type PipelineUpdateData = z.infer<typeof UpdatePipelineSchema>;

function buildPipelineSetData(data: PipelineUpdateData, ts: number) {
	const setData: {
		updatedAt: number;
		name?: string;
		defaultOnboardingTemplate?: string | null;
		isDefault?: number;
	} = { updatedAt: ts };

	if (data.name !== undefined) setData.name = data.name;
	if ("defaultOnboardingTemplate" in data)
		setData.defaultOnboardingTemplate = data.defaultOnboardingTemplate ?? null;
	if (data.isDefault !== undefined) setData.isDefault = data.isDefault ? 1 : 0;

	return setData;
}

export async function updatePipeline(ctx: ServiceCtx, id: string, raw: unknown) {
	assertCanMutate(ctx);
	const result = UpdatePipelineSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	await requirePipeline(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	const setData = buildPipelineSetData(result.data, now());
	try {
		await orm
			.update(schema.crmPipelines)
			.set(setData)
			.where(
				and(eq(schema.crmPipelines.id, id), eq(schema.crmPipelines.workspaceId, ctx.workspaceId))
			);
	} catch (e) {
		if (isUniqueConstraintError(e)) {
			throw new ConflictError("Only one default pipeline is allowed per workspace");
		}
		throw e;
	}

	return { ok: true };
}

export async function createStage(ctx: ServiceCtx, raw: unknown) {
	assertCanMutate(ctx);
	const result = CreateStageSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { pipelineId, name, position, kind, probability, requiredFields } = result.data;

	await requirePipeline(ctx, pipelineId);
	if (requiredFields) assertRequiredFieldsKnown(requiredFields);

	const current = await listPipelineStageKinds(ctx, pipelineId);
	assertWonLostInvariant(current, [...current, { id: "new", kind }]);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	try {
		await orm.insert(schema.crmStages).values({
			id,
			workspaceId: ctx.workspaceId,
			pipelineId,
			name,
			position,
			kind,
			probability: probability ?? null,
			requiredFields: JSON.stringify(requiredFields ?? []),
			createdAt: ts,
			updatedAt: ts,
		});
	} catch (e) {
		if (isUniqueConstraintError(e)) {
			throw new ConflictError(
				`Position ${position} is already used by another stage in this pipeline`
			);
		}
		throw e;
	}

	return { id };
}

export async function listStages(ctx: ServiceCtx, pipelineId: string) {
	await requirePipeline(ctx, pipelineId);

	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmStages)
		.where(
			and(
				eq(schema.crmStages.pipelineId, pipelineId),
				eq(schema.crmStages.workspaceId, ctx.workspaceId)
			)
		)
		.orderBy(asc(schema.crmStages.position));
	return { items };
}

type StageUpdateData = z.infer<typeof UpdateStageSchema>;

function buildStageSetData(data: StageUpdateData, ts: number) {
	const setData: {
		updatedAt: number;
		name?: string;
		position?: number;
		kind?: "open" | "won" | "lost";
		probability?: number | null;
		requiredFields?: string;
	} = { updatedAt: ts };

	if (data.name !== undefined) setData.name = data.name;
	if (data.position !== undefined) setData.position = data.position;
	if (data.kind !== undefined) setData.kind = data.kind;
	if ("probability" in data) setData.probability = data.probability ?? null;
	if (data.requiredFields !== undefined)
		setData.requiredFields = JSON.stringify(data.requiredFields);

	return setData;
}

export async function updateStage(ctx: ServiceCtx, id: string, raw: unknown) {
	assertCanMutate(ctx);
	const result = UpdateStageSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	if (result.data.requiredFields) assertRequiredFieldsKnown(result.data.requiredFields);

	const existing = await requireStageRow(ctx, id);

	const newKind = result.data.kind;
	if (newKind !== undefined) {
		const current = await listPipelineStageKinds(ctx, existing.pipelineId);
		const after = current.map((s) => (s.id === id ? { ...s, kind: newKind } : s));
		assertWonLostInvariant(current, after);
	}

	const orm = drizzle(ctx.db, { schema });
	const setData = buildStageSetData(result.data, now());
	try {
		await orm
			.update(schema.crmStages)
			.set(setData)
			.where(and(eq(schema.crmStages.id, id), eq(schema.crmStages.workspaceId, ctx.workspaceId)));
	} catch (e) {
		if (isUniqueConstraintError(e)) {
			throw new ConflictError("Position is already used by another stage in this pipeline");
		}
		throw e;
	}

	return { ok: true };
}

export async function deleteStage(ctx: ServiceCtx, id: string) {
	assertCanMutate(ctx);
	const existing = await requireStageRow(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	const dealInStage = await orm
		.select({ id: schema.crmDeals.id })
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.stageId, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (dealInStage) throw new ConflictError("Cannot delete a stage with deals in it");

	const current = await listPipelineStageKinds(ctx, existing.pipelineId);
	const after = current.filter((s) => s.id !== id);
	assertWonLostInvariant(current, after);

	await orm
		.delete(schema.crmStages)
		.where(and(eq(schema.crmStages.id, id), eq(schema.crmStages.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function seedDefaultPipeline(db: D1Database, workspaceId: string): Promise<void> {
	const orm = drizzle(db, { schema });
	const existing = await orm
		.select({ id: schema.crmPipelines.id })
		.from(schema.crmPipelines)
		.where(
			and(eq(schema.crmPipelines.workspaceId, workspaceId), eq(schema.crmPipelines.isDefault, 1))
		)
		.get();
	if (existing) return;

	const ts = Math.floor(Date.now() / 1000);
	const pipelineId = crypto.randomUUID();
	await orm.insert(schema.crmPipelines).values({
		id: pipelineId,
		workspaceId,
		name: "Sales",
		defaultOnboardingTemplate: null,
		isDefault: 1,
		createdAt: ts,
		updatedAt: ts,
	});

	const stages: { name: string; kind: "open" | "won" | "lost" }[] = [
		{ name: "Lead", kind: "open" },
		{ name: "Qualified", kind: "open" },
		{ name: "Proposal", kind: "open" },
		{ name: "Won", kind: "won" },
		{ name: "Lost", kind: "lost" },
	];
	for (const [i, s] of stages.entries()) {
		await orm.insert(schema.crmStages).values({
			id: crypto.randomUUID(),
			workspaceId,
			pipelineId,
			name: s.name,
			position: i + 1,
			kind: s.kind,
			probability: null,
			requiredFields: "[]",
			createdAt: ts,
			updatedAt: ts,
		});
	}
}

export async function moveDealStage(
	ctx: ServiceCtx,
	dealId: string,
	newStageId: string,
	opts?: Readonly<{ reason?: string; lostReason?: string }>
) {
	assertCanMutate(ctx);
	const parsed = MoveDealStageSchema.safeParse({
		dealId,
		newStageId,
		reason: opts?.reason,
		lostReason: opts?.lostReason,
	});
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { reason, lostReason } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	const deal = await orm
		.select()
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.id, dealId), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (!deal) throw new NotFoundError("Deal not found");

	const newStage = await requireStageRow(ctx, newStageId);
	if (!deal.pipelineId || newStage.pipelineId !== deal.pipelineId) {
		throw new ValidationError({
			formErrors: ["Target stage does not belong to the deal's pipeline"],
			fieldErrors: {},
		});
	}

	let currentPosition = -1;
	if (deal.stageId) {
		const currentStage = await orm
			.select({ position: schema.crmStages.position })
			.from(schema.crmStages)
			.where(
				and(
					eq(schema.crmStages.id, deal.stageId),
					eq(schema.crmStages.workspaceId, ctx.workspaceId)
				)
			)
			.get();
		if (currentStage) currentPosition = currentStage.position;
	}

	if (newStage.position > currentPosition) {
		const requiredFields: string[] = JSON.parse(newStage.requiredFields);
		const dealRecord = deal as unknown as Record<string, unknown>;
		const missing = requiredFields.filter((field) => {
			const value = dealRecord[field];
			return value === null || value === undefined || value === "";
		});
		if (missing.length > 0) {
			throw new ValidationError({
				formErrors: [`Missing required field(s) for this stage: ${missing.join(", ")}`],
				fieldErrors: {},
			});
		}
	} else if (newStage.position < currentPosition) {
		if (!reason || reason.trim().length === 0) {
			throw new ValidationError({
				formErrors: ["A reason is required to move a deal back to an earlier stage"],
				fieldErrors: {},
			});
		}
	}

	if (newStage.kind === "lost" && (!lostReason || lostReason.trim().length === 0)) {
		throw new ValidationError({
			formErrors: ["lostReason is required when moving a deal to a lost stage"],
			fieldErrors: {},
		});
	}

	const ts = now();
	const setData: {
		stageId: string;
		updatedAt: number;
		wonAt?: number | null;
		lostReason?: string | null;
	} = { stageId: newStageId, updatedAt: ts };
	if (newStage.kind === "won") setData.wonAt = ts;
	if (newStage.kind === "lost") setData.lostReason = lostReason ?? null;

	await orm
		.update(schema.crmDeals)
		.set(setData)
		.where(and(eq(schema.crmDeals.id, dealId), eq(schema.crmDeals.workspaceId, ctx.workspaceId)));

	await recordActivity(ctx, {
		entityType: "deal",
		entityId: dealId,
		action: "updated",
		diff: {
			fromStageId: deal.stageId,
			toStageId: newStageId,
			...(reason ? { reason } : {}),
		},
	});

	return { ok: true };
}
