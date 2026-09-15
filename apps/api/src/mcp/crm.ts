import type { MCPTool } from "@projektor/types";
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
import { ValidationError } from "../services/errors";

function requireId(input: unknown): { id: string; rest: Record<string, unknown> } {
	const { id, ...rest } = (input ?? {}) as { id?: string; [k: string]: unknown };
	if (!id || typeof id !== "string") {
		throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
	}
	return { id, rest };
}

export const crmTools: MCPTool[] = [
	{
		name: "create_org",
		description: "Create a CRM organisation (company/account)",
		inputSchema: {
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
				domain: { type: "string" },
				sourceRef: { type: "string" },
			},
		},
		handler(input, ctx) {
			return createOrganisation(ctx, input);
		},
	},
	{
		name: "update_org",
		description: "Update a CRM organisation",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				domain: { type: "string", nullable: true },
				sourceRef: { type: "string", nullable: true },
			},
		},
		handler(input, ctx) {
			const { id, rest } = requireId(input);
			return updateOrganisation(ctx, id, rest);
		},
	},
	{
		name: "list_orgs",
		description: "List CRM organisations in the workspace",
		inputSchema: { type: "object", properties: {} },
		handler(_input, ctx) {
			return listOrganisations(ctx);
		},
	},
	{
		name: "get_org",
		description: "Get a CRM organisation by id",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		handler(input, ctx) {
			const { id } = requireId(input);
			return getOrganisation(ctx, id);
		},
	},
	{
		name: "create_contact",
		description: "Create a contact for a CRM organisation, recording consent basis and timestamp",
		inputSchema: {
			type: "object",
			required: ["orgId", "name", "email", "consentBasis", "consentAt"],
			properties: {
				orgId: { type: "string" },
				name: { type: "string" },
				email: { type: "string" },
				role: { type: "string" },
				consentBasis: { type: "string", enum: ["contract", "legitimate_interest", "consent"] },
				consentAt: { type: "number", description: "Epoch seconds consent was given" },
			},
		},
		handler(input, ctx) {
			return createContact(ctx, input);
		},
	},
	{
		name: "update_contact",
		description: "Update a contact",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				email: { type: "string" },
				role: { type: "string", nullable: true },
				consentBasis: { type: "string", enum: ["contract", "legitimate_interest", "consent"] },
				consentAt: { type: "number" },
			},
		},
		handler(input, ctx) {
			const { id, rest } = requireId(input);
			return updateContact(ctx, id, rest);
		},
	},
	{
		name: "list_contacts",
		description: "List contacts for a CRM organisation",
		inputSchema: {
			type: "object",
			required: ["orgId"],
			properties: { orgId: { type: "string" } },
		},
		handler(input, ctx) {
			const { orgId } = input as { orgId?: string };
			if (!orgId) throw new ValidationError({ formErrors: ["orgId is required"], fieldErrors: {} });
			return listContactsByOrg(ctx, orgId);
		},
	},
	{
		name: "create_deal",
		description: "Create a deal for a CRM organisation",
		inputSchema: {
			type: "object",
			required: ["orgId", "currency"],
			properties: {
				orgId: { type: "string" },
				pipelineId: { type: "string" },
				stageId: { type: "string" },
				ownerUserId: { type: "string" },
				expectedClose: { type: "number", description: "Epoch seconds" },
				currency: { type: "string", description: "ISO 4217 code, e.g. USD" },
				valueOverride: { type: "number" },
				lostReason: { type: "string" },
				wonAt: { type: "number" },
			},
		},
		handler(input, ctx) {
			return createDeal(ctx, input);
		},
	},
	{
		name: "update_deal",
		description:
			"Update a deal's pipeline, owner, expected close, currency, or value override. " +
			"stageId/wonAt/lostReason cannot be set here — use move_deal_stage.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				pipelineId: { type: "string", nullable: true },
				ownerUserId: { type: "string", nullable: true },
				expectedClose: { type: "number", nullable: true },
				currency: { type: "string" },
				valueOverride: { type: "number", nullable: true },
			},
		},
		handler(input, ctx) {
			const { id, rest } = requireId(input);
			return updateDeal(ctx, id, rest);
		},
	},
	{
		name: "set_deal_lines",
		description:
			"Replace a deal's line items (product + pricing plan + quantity) and recompute its valuation",
		inputSchema: {
			type: "object",
			required: ["dealId", "lines"],
			properties: {
				dealId: { type: "string" },
				lines: {
					type: "array",
					maxItems: 50,
					items: {
						type: "object",
						required: ["productId", "planId", "qty"],
						properties: {
							productId: { type: "string" },
							planId: { type: "string" },
							qty: { type: "number" },
						},
					},
				},
			},
		},
		handler(input, ctx) {
			const { dealId, lines } = (input ?? {}) as { dealId?: string; lines?: unknown };
			if (!dealId) {
				throw new ValidationError({ formErrors: ["dealId is required"], fieldErrors: {} });
			}
			return setDealLines(ctx, dealId, lines);
		},
	},
	{
		name: "move_deal_stage",
		description:
			"Move a deal to a new stage in its pipeline. A reason is required to move a deal " +
			"backward; a lostReason is required when moving into a lost-kind stage.",
		inputSchema: {
			type: "object",
			required: ["dealId", "newStageId"],
			properties: {
				dealId: { type: "string" },
				newStageId: { type: "string" },
				reason: { type: "string" },
				lostReason: { type: "string" },
			},
		},
		handler(input, ctx) {
			const { dealId, newStageId, reason, lostReason } = (input ?? {}) as {
				dealId?: string;
				newStageId?: string;
				reason?: string;
				lostReason?: string;
			};
			if (!dealId || !newStageId) {
				throw new ValidationError({
					formErrors: ["dealId and newStageId are required"],
					fieldErrors: {},
				});
			}
			return moveDealStage(ctx, dealId, newStageId, { reason, lostReason });
		},
	},
	{
		name: "list_deals",
		description: "List deals for a CRM organisation",
		inputSchema: {
			type: "object",
			required: ["orgId"],
			properties: { orgId: { type: "string" } },
		},
		handler(input, ctx) {
			const { orgId } = input as { orgId?: string };
			if (!orgId) throw new ValidationError({ formErrors: ["orgId is required"], fieldErrors: {} });
			return listDealsByOrg(ctx, orgId);
		},
	},
	{
		name: "get_deal",
		description: "Get a deal by id",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		handler(input, ctx) {
			const { id } = requireId(input);
			return getDeal(ctx, id);
		},
	},
	{
		name: "log_interaction",
		description: "Log a completed interaction (call, email, demo, or note) against a deal",
		inputSchema: {
			type: "object",
			required: ["dealId", "type", "occurredAt", "summary", "author"],
			properties: {
				dealId: { type: "string" },
				type: { type: "string", enum: ["call", "email", "demo", "note"] },
				occurredAt: { type: "number", description: "Epoch seconds" },
				summary: { type: "string" },
				author: { type: "string" },
			},
		},
		handler(input, ctx) {
			return createInteraction(ctx, input);
		},
	},
	{
		name: "list_interactions",
		description: "List interactions logged against a deal",
		inputSchema: {
			type: "object",
			required: ["dealId"],
			properties: { dealId: { type: "string" } },
		},
		handler(input, ctx) {
			const { dealId } = input as { dealId?: string };
			if (!dealId) {
				throw new ValidationError({ formErrors: ["dealId is required"], fieldErrors: {} });
			}
			return listInteractionsByDeal(ctx, dealId);
		},
	},
	{
		name: "link_deal",
		description:
			"Attach a wiki-page reference or an external URL (e.g. a related issue or feedback item) to a deal",
		inputSchema: {
			type: "object",
			required: ["kind", "dealId"],
			properties: {
				kind: { type: "string", enum: ["wiki_ref", "url"] },
				dealId: { type: "string" },
				wikiPageId: { type: "string", description: "Required when kind is 'wiki_ref'" },
				url: { type: "string", description: "Required when kind is 'url'" },
				label: { type: "string", description: "Optional display label when kind is 'url'" },
			},
		},
		handler(input, ctx) {
			return linkDeal(ctx, input);
		},
	},
	{
		name: "list_stale_deals",
		description:
			"List deals with no interaction logged in the last N days (default: workspace's " +
			"crm.stale_deal_days setting, else 14)",
		inputSchema: {
			type: "object",
			properties: {
				days: { type: "number", description: "Override the stale-deal threshold in days" },
			},
		},
		handler(input, ctx) {
			return listStaleDeals(ctx, input);
		},
	},
	{
		name: "get_pipeline_summary",
		description:
			"Deal counts and total value (in the workspace base currency) per stage of a pipeline",
		inputSchema: {
			type: "object",
			required: ["pipelineId"],
			properties: { pipelineId: { type: "string" } },
		},
		handler(input, ctx) {
			const { pipelineId } = input as { pipelineId?: string };
			if (!pipelineId) {
				throw new ValidationError({ formErrors: ["pipelineId is required"], fieldErrors: {} });
			}
			return getPipelineSummary(ctx, pipelineId);
		},
	},
	{
		name: "get_target_progress",
		description: "Get a target's actual-vs-value progress for its current period",
		inputSchema: {
			type: "object",
			required: ["targetId"],
			properties: { targetId: { type: "string" } },
		},
		handler(input, ctx) {
			const { targetId } = input as { targetId?: string };
			if (!targetId) {
				throw new ValidationError({ formErrors: ["targetId is required"], fieldErrors: {} });
			}
			return getTargetProgress(ctx, targetId);
		},
	},
	{
		name: "draft_followup",
		description:
			"Store a drafted follow-up interaction against a deal without sending anything — the " +
			"interaction is recorded with type 'draft' for a human to review and send",
		inputSchema: {
			type: "object",
			required: ["dealId", "occurredAt", "summary", "author"],
			properties: {
				dealId: { type: "string" },
				occurredAt: { type: "number", description: "Epoch seconds" },
				summary: { type: "string" },
				author: { type: "string" },
			},
		},
		handler(input, ctx) {
			return draftFollowup(ctx, input);
		},
	},
	{
		name: "export_contact",
		description:
			"Export a contact's full record — profile, linked interactions, and deals — for GDPR data export",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		handler(input, ctx) {
			const { id } = requireId(input);
			return exportContact(ctx, id);
		},
	},
	{
		name: "anonymise_contact",
		description: "Anonymise a contact's name and email in place (GDPR right to erasure)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		handler(input, ctx) {
			const { id } = requireId(input);
			return anonymiseContact(ctx, id);
		},
	},
	{
		name: "delete_contact",
		description: "Delete a contact",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		handler(input, ctx) {
			const { id } = requireId(input);
			return deleteContact(ctx, id);
		},
	},
	{
		name: "list_pipelines",
		description: "List sales pipelines in the workspace",
		inputSchema: { type: "object", properties: {} },
		handler(_input, ctx) {
			return listPipelines(ctx);
		},
	},
	{
		name: "create_pipeline",
		description: "Create a sales pipeline",
		inputSchema: {
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
				defaultOnboardingTemplate: { type: "string" },
				isDefault: { type: "boolean" },
			},
		},
		handler(input, ctx) {
			return createPipeline(ctx, input);
		},
	},
	{
		name: "update_pipeline",
		description: "Update a sales pipeline",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				defaultOnboardingTemplate: { type: "string", nullable: true },
				isDefault: { type: "boolean" },
			},
		},
		handler(input, ctx) {
			const { id, rest } = requireId(input);
			return updatePipeline(ctx, id, rest);
		},
	},
	{
		name: "list_products",
		description: "List CRM products",
		inputSchema: { type: "object", properties: {} },
		handler(_input, ctx) {
			return listProducts(ctx);
		},
	},
	{
		name: "create_product",
		description: "Create a CRM product",
		inputSchema: {
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
				onboardingTemplate: { type: "string" },
			},
		},
		handler(input, ctx) {
			return createProduct(ctx, input);
		},
	},
	{
		name: "create_pricing_plan",
		description: "Create a pricing plan for a product",
		inputSchema: {
			type: "object",
			required: ["productId", "name", "interval", "currency", "amount"],
			properties: {
				productId: { type: "string" },
				name: { type: "string" },
				interval: { type: "string", enum: ["one_off", "monthly", "annual"] },
				currency: { type: "string", description: "ISO 4217 code, e.g. USD" },
				amount: { type: "number", description: "Minor units, e.g. cents" },
			},
		},
		handler(input, ctx) {
			return createPricingPlan(ctx, input);
		},
	},
	{
		name: "create_target",
		description: "Create a sales target for a metric and period",
		inputSchema: {
			type: "object",
			required: ["metric", "period", "periodStart", "value"],
			properties: {
				metric: {
					type: "string",
					enum: [
						"deals_created",
						"deals_won",
						"won_value",
						"stage_entered",
						"onboardings_completed",
					],
				},
				stageId: { type: "string", description: "Required when metric is stage_entered" },
				period: { type: "string", enum: ["week", "month", "quarter", "year"] },
				periodStart: { type: "number", description: "Epoch seconds" },
				value: { type: "number" },
				currency: { type: "string" },
			},
		},
		handler(input, ctx) {
			return createTarget(ctx, input);
		},
	},
	{
		name: "list_targets",
		description: "List sales targets",
		inputSchema: { type: "object", properties: {} },
		handler(_input, ctx) {
			return listTargets(ctx);
		},
	},
	{
		name: "set_fx_rate",
		description: "Set (or update) the manual FX rate between two currencies",
		inputSchema: {
			type: "object",
			required: ["fromCurrency", "toCurrency", "rate"],
			properties: {
				fromCurrency: { type: "string" },
				toCurrency: { type: "string" },
				rate: { type: "number" },
			},
		},
		handler(input, ctx) {
			const { fromCurrency, toCurrency, rate } = (input ?? {}) as {
				fromCurrency?: string;
				toCurrency?: string;
				rate?: number;
			};
			if (!fromCurrency || !toCurrency || rate === undefined) {
				throw new ValidationError({
					formErrors: ["fromCurrency, toCurrency, and rate are required"],
					fieldErrors: {},
				});
			}
			return setFxRate(ctx, fromCurrency, toCurrency, rate);
		},
	},
];
