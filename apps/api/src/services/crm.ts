import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import type { z } from "zod";
import {
	CreateContactSchema,
	CreateDealSchema,
	CreateInteractionSchema,
	CreateOrganisationSchema,
	CreatePipelineSchema,
	CreatePricingPlanSchema,
	CreateProductSchema,
	CreateStageSchema,
	CreateTargetSchema,
	LinkInteractionContactSchema,
	MoveDealStageSchema,
	SetBaseCurrencySchema,
	SetDealLinesSchema,
	SetFxRateSchema,
	SetRetentionDaysSchema,
	UpdateContactSchema,
	UpdateDealSchema,
	UpdateInteractionSchema,
	UpdateOrganisationSchema,
	UpdatePipelineSchema,
	UpdatePricingPlanSchema,
	UpdateProductSchema,
	UpdateStageSchema,
	UpdateTargetSchema,
} from "../schemas/crm";
import { recordActivity } from "./activity";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
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
	const { orgId, name, email, role, consentBasis, consentAt } = result.data;

	await requireOrganisation(ctx, orgId);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();
	const retentionUntil = await computeRetentionUntil(ctx, consentBasis, consentAt);

	await orm.insert(schema.crmContacts).values({
		id,
		workspaceId: ctx.workspaceId,
		orgId,
		name,
		email,
		role: role ?? null,
		consentBasis,
		consentAt,
		retentionUntil,
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

function buildContactSetData(data: ContactUpdateData, ts: number, retentionUntil: number | null) {
	const setData: {
		updatedAt: number;
		name?: string;
		email?: string;
		role?: string | null;
		consentBasis?: "contract" | "legitimate_interest" | "consent";
		consentAt?: number;
		retentionUntil?: number | null;
	} = { updatedAt: ts };

	if (data.name !== undefined) setData.name = data.name;
	if (data.email !== undefined) setData.email = data.email;
	if ("role" in data) setData.role = data.role ?? null;
	if (data.consentBasis !== undefined) {
		setData.consentBasis = data.consentBasis;
		setData.retentionUntil = retentionUntil;
	}
	if (data.consentAt !== undefined) {
		setData.consentAt = data.consentAt;
		setData.retentionUntil = retentionUntil;
	}

	return setData;
}

export async function updateContact(ctx: ServiceCtx, id: string, raw: unknown) {
	assertCanMutate(ctx);
	const result = UpdateContactSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({
			consentBasis: schema.crmContacts.consentBasis,
			consentAt: schema.crmContacts.consentAt,
		})
		.from(schema.crmContacts)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Contact not found");

	let retentionUntil: number | null = null;
	if (result.data.consentBasis !== undefined || result.data.consentAt !== undefined) {
		retentionUntil = await computeRetentionUntil(
			ctx,
			result.data.consentBasis ?? existing.consentBasis,
			result.data.consentAt ?? existing.consentAt
		);
	}

	const setData = buildContactSetData(result.data, now(), retentionUntil);
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

async function hashEmailForAnonymisation(email: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

export async function anonymiseContact(ctx: ServiceCtx, id: string) {
	assertCanMutate(ctx);
	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ email: schema.crmContacts.email })
		.from(schema.crmContacts)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Contact not found");

	const hash = await hashEmailForAnonymisation(existing.email);
	const ts = now();

	await orm
		.update(schema.crmContacts)
		.set({
			name: "Anonymised Contact",
			email: `anon-${hash}@anonymised.invalid`,
			anonymisedAt: ts,
			updatedAt: ts,
		})
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function exportContact(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const contact = await orm
		.select()
		.from(schema.crmContacts)
		.where(and(eq(schema.crmContacts.id, id), eq(schema.crmContacts.workspaceId, ctx.workspaceId)))
		.get();
	if (!contact) throw new NotFoundError("Contact not found");

	const links = await orm
		.select({ interactionId: schema.crmInteractionContacts.interactionId })
		.from(schema.crmInteractionContacts)
		.where(eq(schema.crmInteractionContacts.contactId, id));

	const interactions = await inChunks(
		links.map((l) => l.interactionId),
		(chunk) =>
			orm
				.select()
				.from(schema.crmInteractions)
				.where(
					and(
						inArray(schema.crmInteractions.id, chunk),
						eq(schema.crmInteractions.workspaceId, ctx.workspaceId)
					)
				)
	);

	const deals = await orm
		.select()
		.from(schema.crmDeals)
		.where(
			and(
				eq(schema.crmDeals.orgId, contact.orgId),
				eq(schema.crmDeals.workspaceId, ctx.workspaceId)
			)
		);

	return { contact, interactions, deals };
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
		fxRate: null,
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
	} = { updatedAt: ts };

	if ("pipelineId" in data) setData.pipelineId = data.pipelineId ?? null;
	if ("ownerUserId" in data) setData.ownerUserId = data.ownerUserId ?? null;
	if ("expectedClose" in data) setData.expectedClose = data.expectedClose ?? null;
	if (data.currency !== undefined) setData.currency = data.currency;
	if ("valueOverride" in data) setData.valueOverride = data.valueOverride ?? null;

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
	if (raw && typeof raw === "object" && ("valueBase" in raw || "fxRate" in raw)) {
		throw new ValidationError({
			formErrors: [
				"valueBase and fxRate are computed by the service and cannot be set via updateDeal",
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

	if ("valueOverride" in result.data) {
		const baseCurrency = await getWorkspaceSetting(ctx, BASE_CURRENCY_KEY);
		if (baseCurrency) {
			const refreshed = await orm
				.select()
				.from(schema.crmDeals)
				.where(and(eq(schema.crmDeals.id, id), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
				.get();
			if (refreshed) {
				const value =
					refreshed.valueOverride !== null
						? refreshed.valueOverride
						: await computeDealLineValue(ctx, id);
				await recomputeDealValuation(ctx, id, refreshed.currency, value);
			}
		}
	}

	return { ok: true };
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
	let currentKind: "open" | "won" | "lost" | null = null;
	if (deal.stageId) {
		const currentStage = await orm
			.select({ position: schema.crmStages.position, kind: schema.crmStages.kind })
			.from(schema.crmStages)
			.where(
				and(
					eq(schema.crmStages.id, deal.stageId),
					eq(schema.crmStages.workspaceId, ctx.workspaceId)
				)
			)
			.get();
		if (currentStage) {
			currentPosition = currentStage.position;
			currentKind = currentStage.kind;
		}
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
	else if (currentKind === "won") setData.wonAt = null;
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

async function requireProduct(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const product = await orm
		.select()
		.from(schema.crmProducts)
		.where(and(eq(schema.crmProducts.id, id), eq(schema.crmProducts.workspaceId, ctx.workspaceId)))
		.get();
	if (!product) throw new NotFoundError("Product not found");
	return product;
}

async function requirePricingPlan(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const plan = await orm
		.select()
		.from(schema.crmPricingPlans)
		.where(
			and(
				eq(schema.crmPricingPlans.id, id),
				eq(schema.crmPricingPlans.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!plan) throw new NotFoundError("Pricing plan not found");
	return plan;
}

export async function createProduct(ctx: ServiceCtx, raw: unknown) {
	assertCanMutate(ctx);
	const result = CreateProductSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { name, onboardingTemplate } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	await orm.insert(schema.crmProducts).values({
		id,
		workspaceId: ctx.workspaceId,
		name,
		onboardingTemplate: onboardingTemplate ?? null,
		archivedAt: null,
		createdAt: ts,
		updatedAt: ts,
	});

	return { id };
}

export async function getProduct(ctx: ServiceCtx, id: string) {
	return requireProduct(ctx, id);
}

export async function listProducts(ctx: ServiceCtx) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmProducts)
		.where(eq(schema.crmProducts.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.crmProducts.createdAt));
	return { items };
}

type ProductUpdateData = z.infer<typeof UpdateProductSchema>;

function buildProductSetData(data: ProductUpdateData, ts: number) {
	const setData: { updatedAt: number; name?: string; onboardingTemplate?: string | null } = {
		updatedAt: ts,
	};
	if (data.name !== undefined) setData.name = data.name;
	if ("onboardingTemplate" in data) setData.onboardingTemplate = data.onboardingTemplate ?? null;
	return setData;
}

export async function updateProduct(ctx: ServiceCtx, id: string, raw: unknown) {
	assertCanMutate(ctx);
	const result = UpdateProductSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	await requireProduct(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	const setData = buildProductSetData(result.data, now());
	await orm
		.update(schema.crmProducts)
		.set(setData)
		.where(and(eq(schema.crmProducts.id, id), eq(schema.crmProducts.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function archiveProduct(ctx: ServiceCtx, id: string) {
	assertCanMutate(ctx);
	await requireProduct(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	await orm
		.update(schema.crmProducts)
		.set({ archivedAt: now(), updatedAt: now() })
		.where(and(eq(schema.crmProducts.id, id), eq(schema.crmProducts.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function deleteProduct(ctx: ServiceCtx, id: string) {
	assertCanMutate(ctx);
	await requireProduct(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	const plan = await orm
		.select({ id: schema.crmPricingPlans.id })
		.from(schema.crmPricingPlans)
		.where(
			and(
				eq(schema.crmPricingPlans.productId, id),
				eq(schema.crmPricingPlans.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (plan)
		throw new ConflictError("Cannot delete a product with pricing plans — archive it instead");

	await orm
		.delete(schema.crmProducts)
		.where(and(eq(schema.crmProducts.id, id), eq(schema.crmProducts.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function createPricingPlan(ctx: ServiceCtx, raw: unknown) {
	assertCanMutate(ctx);
	const result = CreatePricingPlanSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { productId, name, interval, currency, amount } = result.data;

	await requireProduct(ctx, productId);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	await orm.insert(schema.crmPricingPlans).values({
		id,
		workspaceId: ctx.workspaceId,
		productId,
		name,
		interval,
		currency,
		amount,
		archivedAt: null,
		createdAt: ts,
		updatedAt: ts,
	});

	return { id };
}

export async function getPricingPlan(ctx: ServiceCtx, id: string) {
	return requirePricingPlan(ctx, id);
}

export async function listPricingPlansByProduct(ctx: ServiceCtx, productId: string) {
	await requireProduct(ctx, productId);

	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmPricingPlans)
		.where(
			and(
				eq(schema.crmPricingPlans.productId, productId),
				eq(schema.crmPricingPlans.workspaceId, ctx.workspaceId)
			)
		)
		.orderBy(asc(schema.crmPricingPlans.createdAt));
	return { items };
}

type PricingPlanUpdateData = z.infer<typeof UpdatePricingPlanSchema>;

function buildPricingPlanSetData(data: PricingPlanUpdateData, ts: number) {
	const setData: {
		updatedAt: number;
		name?: string;
		interval?: "one_off" | "monthly" | "annual";
		currency?: string;
		amount?: number;
	} = { updatedAt: ts };
	if (data.name !== undefined) setData.name = data.name;
	if (data.interval !== undefined) setData.interval = data.interval;
	if (data.currency !== undefined) setData.currency = data.currency;
	if (data.amount !== undefined) setData.amount = data.amount;
	return setData;
}

export async function updatePricingPlan(ctx: ServiceCtx, id: string, raw: unknown) {
	assertCanMutate(ctx);
	const result = UpdatePricingPlanSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	await requirePricingPlan(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	const setData = buildPricingPlanSetData(result.data, now());
	await orm
		.update(schema.crmPricingPlans)
		.set(setData)
		.where(
			and(
				eq(schema.crmPricingPlans.id, id),
				eq(schema.crmPricingPlans.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

export async function archivePricingPlan(ctx: ServiceCtx, id: string) {
	assertCanMutate(ctx);
	await requirePricingPlan(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	await orm
		.update(schema.crmPricingPlans)
		.set({ archivedAt: now(), updatedAt: now() })
		.where(
			and(
				eq(schema.crmPricingPlans.id, id),
				eq(schema.crmPricingPlans.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

export async function deletePricingPlan(ctx: ServiceCtx, id: string) {
	assertCanMutate(ctx);
	await requirePricingPlan(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	const line = await orm
		.select({ id: schema.crmDealLines.id })
		.from(schema.crmDealLines)
		.where(
			and(eq(schema.crmDealLines.planId, id), eq(schema.crmDealLines.workspaceId, ctx.workspaceId))
		)
		.get();
	if (line) {
		throw new ConflictError(
			"Cannot delete a pricing plan referenced by a deal line — archive it instead"
		);
	}

	await orm
		.delete(schema.crmPricingPlans)
		.where(
			and(
				eq(schema.crmPricingPlans.id, id),
				eq(schema.crmPricingPlans.workspaceId, ctx.workspaceId)
			)
		);

	return { ok: true };
}

const BASE_CURRENCY_KEY = "crm.base_currency";

async function getWorkspaceSetting(ctx: ServiceCtx, key: string): Promise<string | null> {
	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ value: schema.workspaceSettings.value })
		.from(schema.workspaceSettings)
		.where(
			and(
				eq(schema.workspaceSettings.workspaceId, ctx.workspaceId),
				eq(schema.workspaceSettings.key, key)
			)
		)
		.get();
	return row?.value ?? null;
}

async function setWorkspaceSetting(ctx: ServiceCtx, key: string, value: string): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	const ts = now();
	await orm
		.insert(schema.workspaceSettings)
		.values({ workspaceId: ctx.workspaceId, key, value, updatedAt: ts })
		.onConflictDoUpdate({
			target: [schema.workspaceSettings.workspaceId, schema.workspaceSettings.key],
			set: { value, updatedAt: ts },
		});
}

export async function setWorkspaceBaseCurrency(ctx: ServiceCtx, baseCurrency: string) {
	assertCanMutate(ctx);
	const result = SetBaseCurrencySchema.safeParse({ baseCurrency });
	if (!result.success) throw new ValidationError(result.error.flatten());

	const current = await getWorkspaceSetting(ctx, BASE_CURRENCY_KEY);
	if (current !== null && current !== result.data.baseCurrency) {
		const orm = drizzle(ctx.db, { schema });
		const dealWithValue = await orm
			.select({ id: schema.crmDeals.id })
			.from(schema.crmDeals)
			.where(
				and(eq(schema.crmDeals.workspaceId, ctx.workspaceId), isNotNull(schema.crmDeals.valueBase))
			)
			.get();
		if (dealWithValue) {
			throw new ConflictError(
				"Changing base currency would leave existing deals' value_base stale and mixed-currency — reconcile or recompute them manually before changing it"
			);
		}
	}

	await setWorkspaceSetting(ctx, BASE_CURRENCY_KEY, result.data.baseCurrency);
	return { ok: true };
}

export async function getWorkspaceBaseCurrency(ctx: ServiceCtx): Promise<string | null> {
	return getWorkspaceSetting(ctx, BASE_CURRENCY_KEY);
}

const RETENTION_DAYS_KEY = "crm.retention_days";

type ConsentBasis = "contract" | "legitimate_interest" | "consent";

const DEFAULT_RETENTION_DAYS: Record<ConsentBasis, number> = {
	contract: 2555,
	legitimate_interest: 730,
	consent: 365,
};

export async function getWorkspaceRetentionDays(
	ctx: ServiceCtx
): Promise<Record<ConsentBasis, number>> {
	const raw = await getWorkspaceSetting(ctx, RETENTION_DAYS_KEY);
	const overrides = raw ? (JSON.parse(raw) as Partial<Record<ConsentBasis, number>>) : {};
	return { ...DEFAULT_RETENTION_DAYS, ...overrides };
}

export async function setWorkspaceRetentionDays(ctx: ServiceCtx, raw: unknown) {
	assertCanMutate(ctx);
	const result = SetRetentionDaysSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const current = await getWorkspaceRetentionDays(ctx);
	const merged = { ...current, ...result.data };
	await setWorkspaceSetting(ctx, RETENTION_DAYS_KEY, JSON.stringify(merged));
	return { ok: true };
}

async function computeRetentionUntil(
	ctx: ServiceCtx,
	consentBasis: ConsentBasis,
	consentAt: number
): Promise<number> {
	const retentionDays = await getWorkspaceRetentionDays(ctx);
	return consentAt + retentionDays[consentBasis] * 86400;
}

export async function setFxRate(
	ctx: ServiceCtx,
	fromCurrency: string,
	toCurrency: string,
	rate: number
) {
	assertCanMutate(ctx);
	const result = SetFxRateSchema.safeParse({ fromCurrency, toCurrency, rate });
	if (!result.success) throw new ValidationError(result.error.flatten());

	const orm = drizzle(ctx.db, { schema });
	const ts = now();
	const rateStr = result.data.rate.toString();

	await orm
		.insert(schema.crmFxRates)
		.values({
			id: crypto.randomUUID(),
			workspaceId: ctx.workspaceId,
			fromCurrency: result.data.fromCurrency,
			toCurrency: result.data.toCurrency,
			rate: rateStr,
			asOf: ts,
			source: "manual",
			createdAt: ts,
		})
		.onConflictDoUpdate({
			target: [
				schema.crmFxRates.workspaceId,
				schema.crmFxRates.fromCurrency,
				schema.crmFxRates.toCurrency,
			],
			set: { rate: rateStr, asOf: ts, source: "manual" },
		});

	return { ok: true };
}

async function getFxRate(
	ctx: ServiceCtx,
	fromCurrency: string,
	toCurrency: string
): Promise<number | null> {
	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ rate: schema.crmFxRates.rate })
		.from(schema.crmFxRates)
		.where(
			and(
				eq(schema.crmFxRates.workspaceId, ctx.workspaceId),
				eq(schema.crmFxRates.fromCurrency, fromCurrency),
				eq(schema.crmFxRates.toCurrency, toCurrency)
			)
		)
		.get();
	return row ? Number(row.rate) : null;
}

function annualMultiplier(interval: "one_off" | "monthly" | "annual"): number {
	return interval === "monthly" ? 12 : 1;
}

async function computeDealLineValue(ctx: ServiceCtx, dealId: string): Promise<number> {
	const orm = drizzle(ctx.db, { schema });
	const lines = await orm
		.select({
			amount: schema.crmDealLines.amount,
			qty: schema.crmDealLines.qty,
			planId: schema.crmDealLines.planId,
		})
		.from(schema.crmDealLines)
		.where(
			and(
				eq(schema.crmDealLines.dealId, dealId),
				eq(schema.crmDealLines.workspaceId, ctx.workspaceId)
			)
		);

	let total = 0;
	for (const line of lines) {
		let multiplier = 1;
		if (line.planId) {
			const plan = await orm
				.select({ interval: schema.crmPricingPlans.interval })
				.from(schema.crmPricingPlans)
				.where(
					and(
						eq(schema.crmPricingPlans.id, line.planId),
						eq(schema.crmPricingPlans.workspaceId, ctx.workspaceId)
					)
				)
				.get();
			if (plan) multiplier = annualMultiplier(plan.interval);
		}
		total += line.amount * line.qty * multiplier;
	}
	return total;
}

async function resolveDealFxRate(ctx: ServiceCtx, dealCurrency: string): Promise<number> {
	const baseCurrency = await getWorkspaceSetting(ctx, BASE_CURRENCY_KEY);
	if (!baseCurrency) {
		throw new ValidationError({
			formErrors: ["Workspace base_currency is not configured"],
			fieldErrors: {},
		});
	}
	if (dealCurrency === baseCurrency) return 1;

	const rate = await getFxRate(ctx, dealCurrency, baseCurrency);
	if (rate === null) {
		throw new ValidationError({
			formErrors: [`Missing FX rate for ${dealCurrency} -> ${baseCurrency}`],
			fieldErrors: {},
		});
	}
	return rate;
}

async function applyDealValuation(
	ctx: ServiceCtx,
	dealId: string,
	valueBase: number,
	fxRate: number
): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	await orm
		.update(schema.crmDeals)
		.set({ valueBase, fxRate, updatedAt: now() })
		.where(and(eq(schema.crmDeals.id, dealId), eq(schema.crmDeals.workspaceId, ctx.workspaceId)));
}

async function recomputeDealValuation(
	ctx: ServiceCtx,
	dealId: string,
	dealCurrency: string,
	computedValue: number
): Promise<void> {
	const fxRate = await resolveDealFxRate(ctx, dealCurrency);
	await applyDealValuation(ctx, dealId, Math.round(computedValue * fxRate), fxRate);
}

export async function setDealLines(ctx: ServiceCtx, dealId: string, rawLines: unknown) {
	assertCanMutate(ctx);
	const result = SetDealLinesSchema.safeParse({ lines: rawLines });
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { lines } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const deal = await orm
		.select()
		.from(schema.crmDeals)
		.where(and(eq(schema.crmDeals.id, dealId), eq(schema.crmDeals.workspaceId, ctx.workspaceId)))
		.get();
	if (!deal) throw new NotFoundError("Deal not found");

	const resolvedLines: {
		productId: string;
		planId: string;
		qty: number;
		currency: string;
		amount: number;
		interval: "one_off" | "monthly" | "annual";
	}[] = [];

	for (const line of lines) {
		const plan = await requirePricingPlan(ctx, line.planId);
		if (plan.productId !== line.productId) {
			throw new ValidationError({
				formErrors: [`planId ${line.planId} does not belong to productId ${line.productId}`],
				fieldErrors: {},
			});
		}
		if (plan.currency !== deal.currency) {
			throw new ValidationError({
				formErrors: [
					`Plan currency ${plan.currency} does not match deal currency ${deal.currency}`,
				],
				fieldErrors: {},
			});
		}
		resolvedLines.push({
			productId: line.productId,
			planId: line.planId,
			qty: line.qty,
			currency: plan.currency,
			amount: plan.amount,
			interval: plan.interval,
		});
	}

	const computedValue =
		deal.valueOverride !== null
			? deal.valueOverride
			: resolvedLines.reduce((sum, l) => sum + l.amount * l.qty * annualMultiplier(l.interval), 0);

	const fxRate = await resolveDealFxRate(ctx, deal.currency);

	const ts = now();
	await orm
		.delete(schema.crmDealLines)
		.where(
			and(
				eq(schema.crmDealLines.dealId, dealId),
				eq(schema.crmDealLines.workspaceId, ctx.workspaceId)
			)
		);

	for (const line of resolvedLines) {
		await orm.insert(schema.crmDealLines).values({
			id: crypto.randomUUID(),
			workspaceId: ctx.workspaceId,
			dealId,
			productId: line.productId,
			planId: line.planId,
			qty: line.qty,
			currency: line.currency,
			amount: line.amount,
			createdAt: ts,
		});
	}

	await applyDealValuation(ctx, dealId, Math.round(computedValue * fxRate), fxRate);

	return { ok: true };
}

async function requireTargetRow(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const target = await orm
		.select()
		.from(schema.crmTargets)
		.where(and(eq(schema.crmTargets.id, id), eq(schema.crmTargets.workspaceId, ctx.workspaceId)))
		.get();
	if (!target) throw new NotFoundError("Target not found");
	return target;
}

export async function createTarget(ctx: ServiceCtx, raw: unknown) {
	assertCanMutate(ctx);
	const result = CreateTargetSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { metric, stageId, period, periodStart, value, currency } = result.data;

	if (stageId) await requireStageRow(ctx, stageId);

	const orm = drizzle(ctx.db, { schema });
	const id = crypto.randomUUID();
	const ts = now();

	await orm.insert(schema.crmTargets).values({
		id,
		workspaceId: ctx.workspaceId,
		metric,
		stageId: stageId ?? null,
		period,
		periodStart,
		value,
		currency: currency ?? null,
		createdAt: ts,
		updatedAt: ts,
	});

	return { id };
}

export async function getTarget(ctx: ServiceCtx, id: string) {
	return requireTargetRow(ctx, id);
}

export async function listTargets(ctx: ServiceCtx) {
	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.crmTargets)
		.where(eq(schema.crmTargets.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.crmTargets.periodStart));
	return { items };
}

type TargetUpdateData = z.infer<typeof UpdateTargetSchema>;

function buildTargetSetData(data: TargetUpdateData, ts: number) {
	const setData: {
		updatedAt: number;
		period?: "week" | "month" | "quarter" | "year";
		periodStart?: number;
		value?: number;
		currency?: string | null;
	} = { updatedAt: ts };

	if (data.period !== undefined) setData.period = data.period;
	if (data.periodStart !== undefined) setData.periodStart = data.periodStart;
	if (data.value !== undefined) setData.value = data.value;
	if ("currency" in data) setData.currency = data.currency ?? null;

	return setData;
}

export async function updateTarget(ctx: ServiceCtx, id: string, raw: unknown) {
	assertCanMutate(ctx);
	const result = UpdateTargetSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	await requireTargetRow(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	const setData = buildTargetSetData(result.data, now());
	await orm
		.update(schema.crmTargets)
		.set(setData)
		.where(and(eq(schema.crmTargets.id, id), eq(schema.crmTargets.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function deleteTarget(ctx: ServiceCtx, id: string) {
	assertCanMutate(ctx);
	await requireTargetRow(ctx, id);

	const orm = drizzle(ctx.db, { schema });
	await orm
		.delete(schema.crmTargets)
		.where(and(eq(schema.crmTargets.id, id), eq(schema.crmTargets.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

function daysInUtcMonth(year: number, monthIndex0: number): number {
	return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function periodEndUtcFromWorkspaceUtcClock(
	period: "week" | "month" | "quarter" | "year",
	periodStart: number
): number {
	if (period === "week") return periodStart + 7 * 86400;

	const monthsToAdd = period === "month" ? 1 : period === "quarter" ? 3 : 12;
	const d = new Date(periodStart * 1000);
	const normalized = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsToAdd, 1));
	const targetYear = normalized.getUTCFullYear();
	const targetMonth = normalized.getUTCMonth();
	const clampedDay = Math.min(d.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));
	const end = Date.UTC(
		targetYear,
		targetMonth,
		clampedDay,
		d.getUTCHours(),
		d.getUTCMinutes(),
		d.getUTCSeconds()
	);
	return Math.floor(end / 1000);
}

type CrmTargetRow = Awaited<ReturnType<typeof requireTargetRow>>;

async function computeOnboardingsCompletedActualStubbedUntilOnboardingLands(): Promise<number> {
	return 0;
}

async function computeTargetActual(
	ctx: ServiceCtx,
	target: CrmTargetRow,
	periodEnd: number
): Promise<number> {
	const orm = drizzle(ctx.db, { schema });

	switch (target.metric) {
		case "deals_created": {
			const rows = await orm
				.select({ id: schema.crmDeals.id })
				.from(schema.crmDeals)
				.where(
					and(
						eq(schema.crmDeals.workspaceId, ctx.workspaceId),
						gte(schema.crmDeals.createdAt, target.periodStart),
						lt(schema.crmDeals.createdAt, periodEnd)
					)
				);
			return rows.length;
		}
		case "deals_won": {
			const rows = await orm
				.select({ id: schema.crmDeals.id })
				.from(schema.crmDeals)
				.where(
					and(
						eq(schema.crmDeals.workspaceId, ctx.workspaceId),
						gte(schema.crmDeals.wonAt, target.periodStart),
						lt(schema.crmDeals.wonAt, periodEnd)
					)
				);
			return rows.length;
		}
		case "won_value": {
			const rows = await orm
				.select({ valueBase: schema.crmDeals.valueBase })
				.from(schema.crmDeals)
				.where(
					and(
						eq(schema.crmDeals.workspaceId, ctx.workspaceId),
						gte(schema.crmDeals.wonAt, target.periodStart),
						lt(schema.crmDeals.wonAt, periodEnd)
					)
				);
			return rows.reduce((sum, r) => sum + (r.valueBase ?? 0), 0);
		}
		case "stage_entered": {
			if (!target.stageId) return 0;
			const rows = await orm
				.select({ diff: schema.activity.diff })
				.from(schema.activity)
				.where(
					and(
						eq(schema.activity.workspaceId, ctx.workspaceId),
						eq(schema.activity.entityType, "deal"),
						gte(schema.activity.createdAt, target.periodStart),
						lt(schema.activity.createdAt, periodEnd)
					)
				);
			return rows.filter(
				(r) => (r.diff as { toStageId?: string } | null)?.toStageId === target.stageId
			).length;
		}
		case "onboardings_completed":
			return computeOnboardingsCompletedActualStubbedUntilOnboardingLands();
	}
}

export async function getTargetProgress(ctx: ServiceCtx, targetId: string) {
	const target = await requireTargetRow(ctx, targetId);
	const periodEnd = periodEndUtcFromWorkspaceUtcClock(target.period, target.periodStart);
	const actual = await computeTargetActual(ctx, target, periodEnd);
	const percentOrNullWhenTargetValueIsZero =
		target.value === 0 ? null : (actual / target.value) * 100;
	const daysRemaining = Math.ceil((periodEnd - now()) / 86400);

	return { target, actual, percent: percentOrNullWhenTargetValueIsZero, daysRemaining };
}
