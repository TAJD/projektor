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
});

export const UpdateContactSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		email: z.string().email().optional(),
		role: z.string().max(255).nullable().optional(),
		consentBasis: ConsentBasisEnum.optional(),
		consentAt: z.number().int().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const SetRetentionDaysSchema = z
	.object({
		contract: z.number().int().positive().optional(),
		legitimate_interest: z.number().int().positive().optional(),
		consent: z.number().int().positive().optional(),
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
	lostReason: z.string().max(1000).optional(),
	wonAt: z.number().int().optional(),
});

export const UpdateDealSchema = z
	.object({
		pipelineId: z.string().max(255).nullable().optional(),
		ownerUserId: z.string().uuid().nullable().optional(),
		expectedClose: z.number().int().nullable().optional(),
		currency: CurrencySchema.optional(),
		valueOverride: z.number().int().nullable().optional(),
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
	dealId: z.string().uuid(),
	newStageId: z.string().uuid(),
	reason: z.string().min(1).optional(),
	lostReason: z.string().min(1).max(1000).optional(),
});

const PlanIntervalEnum = z.enum(["one_off", "monthly", "annual"]);

export const CreateProductSchema = z.object({
	name: z.string().min(1).max(255),
	onboardingTemplate: z.string().max(500).optional(),
});

export const UpdateProductSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		onboardingTemplate: z.string().max(500).nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const CreatePricingPlanSchema = z.object({
	productId: z.string().uuid(),
	name: z.string().min(1).max(255),
	interval: PlanIntervalEnum,
	currency: CurrencySchema,
	amount: z.number().int().nonnegative(),
});

export const UpdatePricingPlanSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		interval: PlanIntervalEnum.optional(),
		currency: CurrencySchema.optional(),
		amount: z.number().int().nonnegative().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const SetFxRateSchema = z.object({
	fromCurrency: CurrencySchema,
	toCurrency: CurrencySchema,
	rate: z.number().positive(),
});

export const SetBaseCurrencySchema = z.object({
	baseCurrency: CurrencySchema,
});

export const SetDealLineSchema = z.object({
	productId: z.string().uuid(),
	planId: z.string().uuid(),
	qty: z.number().int().positive(),
});

export const SetDealLinesSchema = z.object({
	lines: z.array(SetDealLineSchema).max(50),
});

const TargetMetricEnum = z.enum([
	"deals_created",
	"deals_won",
	"won_value",
	"stage_entered",
	"onboardings_completed",
]);
const TargetPeriodEnum = z.enum(["week", "month", "quarter", "year"]);

const TARGET_PERIOD_START_MIN = 0;
const TARGET_PERIOD_START_MAX = 4102444800;

export const CreateTargetSchema = z
	.object({
		metric: TargetMetricEnum,
		stageId: z.string().uuid().optional(),
		period: TargetPeriodEnum,
		periodStart: z.number().int().min(TARGET_PERIOD_START_MIN).max(TARGET_PERIOD_START_MAX),
		value: z.number().int().nonnegative(),
		currency: CurrencySchema.optional(),
	})
	.refine((obj) => obj.metric === "stage_entered" || obj.stageId === undefined, {
		message: "stageId is only allowed when metric is stage_entered",
		path: ["stageId"],
	})
	.refine((obj) => obj.metric !== "stage_entered" || obj.stageId !== undefined, {
		message: "stageId is required when metric is stage_entered",
		path: ["stageId"],
	});

export const UpdateTargetSchema = z
	.object({
		period: TargetPeriodEnum.optional(),
		periodStart: z.number().int().optional(),
		value: z.number().int().optional(),
		currency: CurrencySchema.nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const ListStaleDealsSchema = z.object({
	days: z.number().int().positive().max(3650).optional(),
});

export const DraftFollowupSchema = z.object({
	dealId: z.string().uuid(),
	occurredAt: z.number().int(),
	summary: z.string().min(1).max(5000),
	author: z.string().min(1).max(255),
});

export const LinkDealSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("wiki_ref"),
		dealId: z.string().uuid(),
		wikiPageId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("url"),
		dealId: z.string().uuid(),
		url: z
			.string()
			.url()
			.refine((u) => /^https?:\/[/]/i.test(u), "URL must be http or https"),
		label: z.string().trim().max(200).optional(),
	}),
]);
