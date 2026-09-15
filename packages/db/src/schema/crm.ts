import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users, workspaces } from "./core";

export const crmOrganisations = sqliteTable(
	"crm_organisations",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		domain: text("domain"),
		sourceRef: text("source_ref"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_organisations_workspace_idx").on(t.workspaceId),
		workspaceDomainIdx: uniqueIndex("crm_organisations_workspace_domain_idx").on(
			t.workspaceId,
			t.domain
		),
	})
);

export const crmContacts = sqliteTable(
	"crm_contacts",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => crmOrganisations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		email: text("email").notNull(),
		role: text("role"),
		consentBasis: text("consent_basis", {
			enum: ["contract", "legitimate_interest", "consent"],
		}).notNull(),
		consentAt: integer("consent_at").notNull(),
		retentionUntil: integer("retention_until"),
		anonymisedAt: integer("anonymised_at"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_contacts_workspace_idx").on(t.workspaceId),
		orgIdx: index("crm_contacts_org_idx").on(t.orgId),
		workspaceEmailIdx: index("crm_contacts_workspace_email_idx").on(t.workspaceId, t.email),
	})
);

export const crmDeals = sqliteTable(
	"crm_deals",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => crmOrganisations.id, { onDelete: "cascade" }),
		pipelineId: text("pipeline_id"),
		stageId: text("stage_id"),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		expectedClose: integer("expected_close"),
		currency: text("currency").notNull(),
		valueOverride: integer("value_override"),
		valueBase: integer("value_base"),
		fxRate: real("fx_rate"),
		lostReason: text("lost_reason"),
		wonAt: integer("won_at"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_deals_workspace_idx").on(t.workspaceId),
		orgIdx: index("crm_deals_org_idx").on(t.orgId),
		workspaceStageIdx: index("crm_deals_workspace_stage_idx").on(t.workspaceId, t.stageId),
		workspacePipelineIdx: index("crm_deals_workspace_pipeline_idx").on(t.workspaceId, t.pipelineId),
	})
);

export const crmDealLines = sqliteTable(
	"crm_deal_lines",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		dealId: text("deal_id")
			.notNull()
			.references(() => crmDeals.id, { onDelete: "cascade" }),
		productId: text("product_id"),
		planId: text("plan_id"),
		qty: integer("qty").notNull(),
		currency: text("currency").notNull(),
		amount: integer("amount").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_deal_lines_workspace_idx").on(t.workspaceId),
		dealIdx: index("crm_deal_lines_deal_idx").on(t.dealId),
	})
);

export const crmInteractions = sqliteTable(
	"crm_interactions",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		dealId: text("deal_id")
			.notNull()
			.references(() => crmDeals.id, { onDelete: "cascade" }),
		type: text("type", { enum: ["call", "email", "demo", "note", "draft"] }).notNull(),
		occurredAt: integer("occurred_at").notNull(),
		summary: text("summary").notNull(),
		author: text("author").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_interactions_workspace_idx").on(t.workspaceId),
		dealIdx: index("crm_interactions_deal_idx").on(t.dealId),
	})
);

export const crmPipelines = sqliteTable(
	"crm_pipelines",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		defaultOnboardingTemplate: text("default_onboarding_template"),
		isDefault: integer("is_default").notNull().default(0),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_pipelines_workspace_idx").on(t.workspaceId),
		workspaceDefaultUniqueIdx: uniqueIndex("crm_pipelines_workspace_default_idx")
			.on(t.workspaceId)
			.where(sql`${t.isDefault} = 1`),
	})
);

export const crmStages = sqliteTable(
	"crm_stages",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		pipelineId: text("pipeline_id")
			.notNull()
			.references(() => crmPipelines.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		position: integer("position").notNull(),
		kind: text("kind", { enum: ["open", "won", "lost"] }).notNull(),
		probability: integer("probability"),
		requiredFields: text("required_fields").notNull().default("[]"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_stages_workspace_idx").on(t.workspaceId),
		pipelineIdx: index("crm_stages_pipeline_idx").on(t.pipelineId),
		pipelinePositionUniqueIdx: uniqueIndex("crm_stages_pipeline_position_idx").on(
			t.pipelineId,
			t.position
		),
	})
);

export const crmProducts = sqliteTable(
	"crm_products",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		onboardingTemplate: text("onboarding_template"),
		archivedAt: integer("archived_at"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_products_workspace_idx").on(t.workspaceId),
	})
);

export const crmPricingPlans = sqliteTable(
	"crm_pricing_plans",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		productId: text("product_id")
			.notNull()
			.references(() => crmProducts.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		interval: text("interval", { enum: ["one_off", "monthly", "annual"] }).notNull(),
		currency: text("currency").notNull(),
		amount: integer("amount").notNull(),
		archivedAt: integer("archived_at"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_pricing_plans_workspace_idx").on(t.workspaceId),
		productIdx: index("crm_pricing_plans_product_idx").on(t.productId),
	})
);

export const crmFxRates = sqliteTable(
	"crm_fx_rates",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		fromCurrency: text("from_currency").notNull(),
		toCurrency: text("to_currency").notNull(),
		rate: text("rate").notNull(),
		asOf: integer("as_of").notNull(),
		source: text("source", { enum: ["manual", "auto"] }).notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_fx_rates_workspace_idx").on(t.workspaceId),
		workspacePairUniqueIdx: uniqueIndex("crm_fx_rates_workspace_pair_idx").on(
			t.workspaceId,
			t.fromCurrency,
			t.toCurrency
		),
	})
);

export const workspaceSettings = sqliteTable(
	"workspace_settings",
	{
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		value: text("value").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.workspaceId, t.key] }),
	})
);

export const crmTargets = sqliteTable(
	"crm_targets",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		metric: text("metric", {
			enum: ["deals_created", "deals_won", "won_value", "stage_entered", "onboardings_completed"],
		}).notNull(),
		stageId: text("stage_id").references(() => crmStages.id, { onDelete: "cascade" }),
		period: text("period", { enum: ["week", "month", "quarter", "year"] }).notNull(),
		periodStart: integer("period_start").notNull(),
		value: integer("value").notNull(),
		currency: text("currency"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		workspaceIdx: index("crm_targets_workspace_idx").on(t.workspaceId),
		workspacePeriodIdx: index("crm_targets_workspace_period_idx").on(t.workspaceId, t.periodStart),
	})
);

export const crmInteractionContacts = sqliteTable(
	"crm_interaction_contacts",
	{
		interactionId: text("interaction_id")
			.notNull()
			.references(() => crmInteractions.id, { onDelete: "cascade" }),
		contactId: text("contact_id")
			.notNull()
			.references(() => crmContacts.id, { onDelete: "cascade" }),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.interactionId, t.contactId] }),
		contactIdx: index("crm_interaction_contacts_contact_idx").on(t.contactId),
	})
);
