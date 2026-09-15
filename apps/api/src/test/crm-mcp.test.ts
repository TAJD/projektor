import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createPipeline,
	createPricingPlan,
	createProduct,
	createStage,
	setWorkspaceBaseCurrency,
} from "../services/crm";
import type { ServiceCtx } from "../services/types";
import { authHeaders, type JsonRpcError, type JsonRpcResult, seedWorkspaceRoles } from "./helpers";

type Roles = Awaited<ReturnType<typeof seedWorkspaceRoles>>;

async function mcpCall<_T>(
	workspaceId: string,
	name: string,
	args: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<{ content: Array<{ text: string }> }> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	return res.json();
}

function isMcpError(
	r: JsonRpcResult<{ content: Array<{ text: string }> }> | JsonRpcError
): r is JsonRpcError {
	return "error" in r;
}

async function call<T>(
	roles: Roles,
	name: string,
	args: unknown,
	headers: Record<string, string>
): Promise<T> {
	await env.DB.prepare("DELETE FROM rate_limit").run();
	const r = await mcpCall<T>(roles.workspace.id, name, args, headers);
	if (isMcpError(r)) throw new Error(`MCP error: ${r.error.message}`);
	return JSON.parse(r.result.content[0].text) as T;
}

function ctxFor(roles: Roles): ServiceCtx {
	return {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: roles.workspace.id,
		userId: roles.owner.user.id,
		role: "owner",
	};
}

describe("CRM MCP domain (PROJ-770)", () => {
	let roles: Roles;
	let ownerHeaders: Record<string, string>;
	let memberHeaders: Record<string, string>;
	let viewerHeaders: Record<string, string>;

	beforeEach(async () => {
		roles = await seedWorkspaceRoles();
		ownerHeaders = authHeaders(roles.owner.token, roles.workspace.slug);
		memberHeaders = authHeaders(roles.member.token, roles.workspace.slug);
		viewerHeaders = authHeaders(roles.viewer.token, roles.workspace.slug);
	});

	it("covers the full record-only lifecycle across orgs, contacts, deals, and interactions", async () => {
		const ctx = ctxFor(roles);
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: pipelineId } = await createPipeline(ctx, { name: "Sales" });
		const { id: stage1 } = await createStage(ctx, {
			pipelineId,
			name: "Lead",
			position: 1,
			kind: "open",
		});
		const { id: stage2 } = await createStage(ctx, {
			pipelineId,
			name: "Won",
			position: 2,
			kind: "won",
		});
		const { id: productId } = await createProduct(ctx, { name: "Widget" });
		const { id: planId } = await createPricingPlan(ctx, {
			productId,
			name: "Monthly",
			interval: "monthly",
			currency: "USD",
			amount: 1000,
		});

		const { id: orgId } = await call<{ id: string }>(
			roles,
			"create_org",
			{ name: "Acme Inc" },
			memberHeaders
		);
		const { id: contactId } = await call<{ id: string }>(
			roles,
			"create_contact",
			{
				orgId,
				name: "Jane Doe",
				email: "jane@example.com",
				consentBasis: "consent",
				consentAt: Math.floor(Date.now() / 1000),
			},
			memberHeaders
		);
		const { id: dealId } = await call<{ id: string }>(
			roles,
			"create_deal",
			{ orgId, pipelineId, stageId: stage1, currency: "USD" },
			memberHeaders
		);
		const { id: staleDealId } = await call<{ id: string }>(
			roles,
			"create_deal",
			{ orgId, pipelineId, stageId: stage1, currency: "USD" },
			memberHeaders
		);

		await call(
			roles,
			"set_deal_lines",
			{ dealId, lines: [{ productId, planId, qty: 2 }] },
			memberHeaders
		);
		const deal = await call<{ valueBase: number | null }>(
			roles,
			"get_deal",
			{ id: dealId },
			memberHeaders
		);
		expect(deal.valueBase).toBe(24000);

		await call(roles, "move_deal_stage", { dealId, newStageId: stage2 }, memberHeaders);

		await call(
			roles,
			"log_interaction",
			{
				dealId,
				type: "call",
				occurredAt: Math.floor(Date.now() / 1000),
				summary: "Intro call",
				author: "Rep",
			},
			memberHeaders
		);
		const { id: draftId } = await call<{ id: string }>(
			roles,
			"draft_followup",
			{
				dealId,
				occurredAt: Math.floor(Date.now() / 1000),
				summary: "Follow up on pricing",
				author: "Rep",
			},
			memberHeaders
		);
		expect(draftId).toBeTruthy();
		const { items: interactions } = await call<{ items: { type: string }[] }>(
			roles,
			"list_interactions",
			{ dealId },
			memberHeaders
		);
		expect(interactions).toHaveLength(2);
		expect(interactions.map((i) => i.type).sort()).toEqual(["call", "draft"]);

		const { items: staleItems } = await call<{ items: { id: string }[] }>(
			roles,
			"list_stale_deals",
			{ days: 3650 },
			memberHeaders
		);
		expect(staleItems.map((d) => d.id)).toContain(staleDealId);
		expect(staleItems.map((d) => d.id)).not.toContain(dealId);

		const summary = await call<{ stages: { stageId: string; dealCount: number }[] }>(
			roles,
			"get_pipeline_summary",
			{ pipelineId },
			memberHeaders
		);
		const wonEntry = summary.stages.find((s) => s.stageId === stage2);
		expect(wonEntry?.dealCount).toBe(1);

		await call(
			roles,
			"link_deal",
			{ kind: "url", dealId, url: "https://example.com/ISSUE-1", label: "related issue" },
			memberHeaders
		);

		const { id: targetId } = await call<{ id: string }>(
			roles,
			"create_target",
			{
				metric: "deals_created",
				period: "year",
				periodStart: Math.floor(Date.now() / 1000) - 3600,
				value: 1,
			},
			memberHeaders
		);
		const progress = await call<{ actual: number }>(
			roles,
			"get_target_progress",
			{ targetId },
			memberHeaders
		);
		expect(progress.actual).toBe(2);

		const exported = await call<{ contact: { id: string } }>(
			roles,
			"export_contact",
			{ id: contactId },
			memberHeaders
		);
		expect(exported.contact.id).toBe(contactId);

		await call(roles, "anonymise_contact", { id: contactId }, memberHeaders);
		await call(roles, "delete_contact", { id: contactId }, memberHeaders);

		await call(
			roles,
			"set_fx_rate",
			{ fromCurrency: "EUR", toCurrency: "USD", rate: 1.1 },
			memberHeaders
		);

		const { items: pipelines } = await call<{ items: unknown[] }>(
			roles,
			"list_pipelines",
			{},
			memberHeaders
		);
		expect(pipelines.length).toBeGreaterThanOrEqual(1);
		const { items: products } = await call<{ items: unknown[] }>(
			roles,
			"list_products",
			{},
			memberHeaders
		);
		expect(products.length).toBeGreaterThanOrEqual(1);
		const { items: targets } = await call<{ items: unknown[] }>(
			roles,
			"list_targets",
			{},
			memberHeaders
		);
		expect(targets.length).toBeGreaterThanOrEqual(1);
	});

	it("blocks a viewer from mutating orgs and pipelines", async () => {
		const orgResult = await mcpCall(
			roles.workspace.id,
			"create_org",
			{ name: "Nope" },
			viewerHeaders
		);
		expect(isMcpError(orgResult)).toBe(true);

		const pipelineResult = await mcpCall(
			roles.workspace.id,
			"create_pipeline",
			{ name: "Nope" },
			viewerHeaders
		);
		expect(isMcpError(pipelineResult)).toBe(true);
	});

	it("scopes reads to the calling workspace and rejects cross-workspace ids", async () => {
		const { id: orgId } = await call<{ id: string }>(
			roles,
			"create_org",
			{ name: "Workspace A Org" },
			ownerHeaders
		);
		const ctx = ctxFor(roles);
		await setWorkspaceBaseCurrency(ctx, "USD");
		const { id: pipelineId } = await createPipeline(ctx, { name: "Sales" });
		const { id: dealId } = await call<{ id: string }>(
			roles,
			"create_deal",
			{ orgId, pipelineId, currency: "USD" },
			ownerHeaders
		);

		const otherRoles = await seedWorkspaceRoles();
		const otherHeaders = authHeaders(otherRoles.owner.token, otherRoles.workspace.slug);

		const orgResult = await mcpCall(
			otherRoles.workspace.id,
			"get_org",
			{ id: orgId },
			otherHeaders
		);
		expect(isMcpError(orgResult)).toBe(true);
		expect((orgResult as JsonRpcError).error.message.toLowerCase()).toContain("not found");

		const dealResult = await mcpCall(
			otherRoles.workspace.id,
			"get_deal",
			{ id: dealId },
			otherHeaders
		);
		expect(isMcpError(dealResult)).toBe(true);

		const linkResult = await mcpCall(
			otherRoles.workspace.id,
			"link_deal",
			{ kind: "url", dealId, url: "https://example.com/ISSUE-2" },
			otherHeaders
		);
		expect(isMcpError(linkResult)).toBe(true);
		expect((linkResult as JsonRpcError).error.message.toLowerCase()).toContain("not found");
	});

	it("REST surface stays in parity with the MCP tools", async () => {
		const res = await SELF.fetch("http://localhost/api/crm/orgs", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "REST Org" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const listRes = await SELF.fetch("http://localhost/api/crm/orgs", { headers: ownerHeaders });
		expect(listRes.status).toBe(200);
		const { items } = (await listRes.json()) as { items: { id: string }[] };
		expect(items.map((o) => o.id)).toContain(id);
	});
});
