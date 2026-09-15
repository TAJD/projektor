import { z } from "zod";

const ConsentBasisEnum = z.enum(["contract", "legitimate_interest", "consent"]);
const InteractionTypeEnum = z.enum(["call", "email", "demo", "note"]);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, "Currency must be an ISO 4217 code");

export const CreateOrganisationSchema = z.object({
	name: z.string().min(1).max(255),
	domain: z.string().max(255).optional(),
	sourceRef: z.string().max(500).optional(),
});

export const UpdateOrganisationSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		domain: z.string().max(255).nullable().optional(),
		sourceRef: z.string().max(500).nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const CreateContactSchema = z.object({
	orgId: z.string().uuid(),
	name: z.string().min(1).max(255),
	email: z.string().email(),
	role: z.string().max(255).optional(),
	consentBasis: ConsentBasisEnum,
	consentAt: z.number().int(),
	retentionUntil: z.number().int().optional(),
});

export const UpdateContactSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		email: z.string().email().optional(),
		role: z.string().max(255).nullable().optional(),
		consentBasis: ConsentBasisEnum.optional(),
		consentAt: z.number().int().optional(),
		retentionUntil: z.number().int().nullable().optional(),
		anonymisedAt: z.number().int().nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const CreateDealSchema = z.object({
	orgId: z.string().uuid(),
	pipelineId: z.string().max(255).optional(),
	stageId: z.string().max(255).optional(),
	ownerUserId: z.string().uuid().optional(),
	expectedClose: z.number().int().optional(),
	currency: CurrencySchema,
	valueOverride: z.number().int().optional(),
	fxRate: z.number().optional(),
	lostReason: z.string().max(1000).optional(),
	wonAt: z.number().int().optional(),
});

export const UpdateDealSchema = z
	.object({
		pipelineId: z.string().max(255).nullable().optional(),
		stageId: z.string().max(255).nullable().optional(),
		ownerUserId: z.string().uuid().nullable().optional(),
		expectedClose: z.number().int().nullable().optional(),
		currency: CurrencySchema.optional(),
		valueOverride: z.number().int().nullable().optional(),
		valueBase: z.number().int().nullable().optional(),
		fxRate: z.number().nullable().optional(),
		lostReason: z.string().max(1000).nullable().optional(),
		wonAt: z.number().int().nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const CreateDealLineSchema = z.object({
	dealId: z.string().uuid(),
	productId: z.string().max(255).optional(),
	planId: z.string().max(255).optional(),
	qty: z.number().int().positive(),
	currency: CurrencySchema,
	amount: z.number().int(),
});

export const UpdateDealLineSchema = z
	.object({
		productId: z.string().max(255).nullable().optional(),
		planId: z.string().max(255).nullable().optional(),
		qty: z.number().int().positive().optional(),
		currency: CurrencySchema.optional(),
		amount: z.number().int().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const CreateInteractionSchema = z.object({
	dealId: z.string().uuid(),
	type: InteractionTypeEnum,
	occurredAt: z.number().int(),
	summary: z.string().min(1).max(5000),
	author: z.string().min(1).max(255),
});

export const UpdateInteractionSchema = z
	.object({
		type: InteractionTypeEnum.optional(),
		occurredAt: z.number().int().optional(),
		summary: z.string().min(1).max(5000).optional(),
		author: z.string().min(1).max(255).optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const LinkInteractionContactSchema = z.object({
	interactionId: z.string().uuid(),
	contactId: z.string().uuid(),
});

const StageKindEnum = z.enum(["open", "won", "lost"]);

export const CreatePipelineSchema = z.object({
	name: z.string().min(1).max(255),
	defaultOnboardingTemplate: z.string().max(500).optional(),
	isDefault: z.boolean().optional(),
});

export const UpdatePipelineSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		defaultOnboardingTemplate: z.string().max(500).nullable().optional(),
		isDefault: z.boolean().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const CreateStageSchema = z.object({
	pipelineId: z.string().uuid(),
	name: z.string().min(1).max(255),
	position: z.number().int(),
	kind: StageKindEnum,
	probability: z.number().int().min(0).max(100).optional(),
	requiredFields: z.array(z.string().min(1)).optional(),
});

export const UpdateStageSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		position: z.number().int().optional(),
		kind: StageKindEnum.optional(),
		probability: z.number().int().min(0).max(100).nullable().optional(),
		requiredFields: z.array(z.string().min(1)).optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const MoveDealStageSchema = z.object({
	newStageId: z.string().uuid(),
	reason: z.string().min(1).optional(),
	lostReason: z.string().min(1).max(1000).optional(),
});
