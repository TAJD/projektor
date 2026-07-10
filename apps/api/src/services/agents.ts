import { drizzle, schema } from "@projektor/db";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
	EndAgentSchema,
	HeartbeatAgentSchema,
	ListActiveAgentsSchema,
	RegisterAgentSchema,
} from "../schemas/agents";
import { visibleProjectPredicate } from "./access";
import { NotFoundError, ValidationError } from "./errors";
import { releaseClaimsForAgent } from "./file-claims";
import { releaseLeasesForAgent } from "./issue-leases";
import type { ServiceCtx } from "./types";

const ACTIVE_TTL = 120;

// PROJ-336: agent_sessions.kind is caller-declared at register_agent with no
// privilege check (the original review-gate spoof vector; PROJ-287 rebound the
// gate to live leases instead, ignoring kind entirely). It drives no remaining
// behavior, so it's excluded here to stop it reading as a trust/attribution
// signal in list_active_agents and register/heartbeat/end responses.
const AGENT_SESSION_COLUMNS = {
	id: schema.agentSessions.id,
	workspaceId: schema.agentSessions.workspaceId,
	issueId: schema.agentSessions.issueId,
	tokenId: schema.agentSessions.tokenId,
	name: schema.agentSessions.name,
	status: schema.agentSessions.status,
	startedAt: schema.agentSessions.startedAt,
	lastHeartbeatAt: schema.agentSessions.lastHeartbeatAt,
	endedAt: schema.agentSessions.endedAt,
};

export async function registerAgent(ctx: ServiceCtx, raw: unknown) {
	const result = RegisterAgentSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId, name } = result.data;

	const orm = drizzle(ctx.db, { schema });

	if (issueId) {
		const issue = await orm
			.select({ id: schema.issues.id })
			.from(schema.issues)
			.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, ctx.workspaceId)))
			.get();
		if (!issue) throw new NotFoundError("Issue not found");
	}

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	// PROJ-336: kind is no longer read from the caller — see AGENT_SESSION_COLUMNS
	// for why it's dropped from every response. The DB column keeps its "agent"
	// default so existing rows/queries are unaffected.
	await orm.insert(schema.agentSessions).values({
		id,
		workspaceId: ctx.workspaceId,
		issueId: issueId ?? null,
		tokenId: null,
		name,
		status: "active",
		startedAt: now,
		lastHeartbeatAt: now,
		endedAt: null,
	});

	const row = await orm
		.select(AGENT_SESSION_COLUMNS)
		.from(schema.agentSessions)
		.where(eq(schema.agentSessions.id, id))
		.get();

	// biome-ignore lint/style/noNonNullAssertion: row was just inserted; SELECT immediately after guarantees it exists
	return row!;
}

export async function heartbeatAgent(ctx: ServiceCtx, raw: unknown) {
	const result = HeartbeatAgentSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { id } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.agentSessions.id })
		.from(schema.agentSessions)
		.where(
			and(
				eq(schema.agentSessions.id, id),
				eq(schema.agentSessions.workspaceId, ctx.workspaceId),
				eq(schema.agentSessions.status, "active")
			)
		)
		.get();
	if (!existing) throw new NotFoundError("Agent session not found");

	const now = Math.floor(Date.now() / 1000);
	await orm
		.update(schema.agentSessions)
		.set({ lastHeartbeatAt: now })
		.where(
			and(eq(schema.agentSessions.id, id), eq(schema.agentSessions.workspaceId, ctx.workspaceId))
		);

	const row = await orm
		.select(AGENT_SESSION_COLUMNS)
		.from(schema.agentSessions)
		.where(eq(schema.agentSessions.id, id))
		.get();

	// biome-ignore lint/style/noNonNullAssertion: row was just updated; SELECT immediately after guarantees it exists
	return row!;
}

export async function endAgent(ctx: ServiceCtx, raw: unknown) {
	const result = EndAgentSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { id } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.agentSessions.id })
		.from(schema.agentSessions)
		.where(
			and(eq(schema.agentSessions.id, id), eq(schema.agentSessions.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!existing) throw new NotFoundError("Agent session not found");

	const now = Math.floor(Date.now() / 1000);
	await orm
		.update(schema.agentSessions)
		.set({ status: "ended", endedAt: now })
		.where(
			and(eq(schema.agentSessions.id, id), eq(schema.agentSessions.workspaceId, ctx.workspaceId))
		);

	await releaseClaimsForAgent(ctx, id);
	await releaseLeasesForAgent(ctx, id);

	const row = await orm
		.select(AGENT_SESSION_COLUMNS)
		.from(schema.agentSessions)
		.where(eq(schema.agentSessions.id, id))
		.get();

	// biome-ignore lint/style/noNonNullAssertion: row was just updated; SELECT immediately after guarantees it exists
	return row!;
}

export async function listActiveAgents(ctx: ServiceCtx, raw: unknown) {
	const result = ListActiveAgentsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const cutoff = Math.floor(Date.now() / 1000) - ACTIVE_TTL;

	const conditions = [
		eq(schema.agentSessions.workspaceId, ctx.workspaceId),
		eq(schema.agentSessions.status, "active"),
		gt(schema.agentSessions.lastHeartbeatAt, cutoff),
	];

	if (issueId) {
		conditions.push(eq(schema.agentSessions.issueId, issueId));
	}

	// PROJ-316: a non-admin member only sees agents working an issue in a project
	// they can access. Agents not tied to any issue carry no project, so they stay
	// workspace-visible. Owner/admin (predicate undefined) see every agent.
	const vis = visibleProjectPredicate(
		ctx,
		sql`(SELECT i.project_id FROM issues i WHERE i.id = ${schema.agentSessions.issueId})`
	);
	if (vis) {
		conditions.push(or(isNull(schema.agentSessions.issueId), vis) ?? vis);
	}

	const items = await orm
		.select(AGENT_SESSION_COLUMNS)
		.from(schema.agentSessions)
		.where(and(...conditions))
		.orderBy(desc(schema.agentSessions.startedAt));

	return { items };
}
