import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { ListMessagesSchema, PostMessageSchema } from "../schemas/agent-messages";
import { NotFoundError, ValidationError } from "./errors";
import { resolveMessageScope } from "./issue-ref";
import type { ServiceCtx } from "./types";

// PROJ-929: mirrors ACTIVE_TTL in services/agents.ts (and SESSION_TTL_SECONDS in
// services/issue-leases.ts / file-claims.ts). Kept local rather than imported for the
// same circular-import reason as those: agents.ts already imports from sibling service
// files, so importing back from here would cycle.
const SESSION_TTL_SECONDS = 120;

// PROJ-929: a post_message call that carries an already-live agentId implicitly
// refreshes that session's heartbeat, same as claim_issue/claim_files. Gated on the
// session being live ALREADY (status='active' AND heartbeat > cutoff) — see
// touchAgentHeartbeatIfLive in file-claims.ts for why an unconditional touch would
// defeat PROJ-636 stale-holder reclaim.
async function touchAgentHeartbeatIfLive(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	agentId: string
): Promise<void> {
	const cutoff = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;
	await orm
		.update(schema.agentSessions)
		.set({ lastHeartbeatAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(schema.agentSessions.id, agentId),
				eq(schema.agentSessions.workspaceId, ctx.workspaceId),
				eq(schema.agentSessions.status, "active"),
				gt(schema.agentSessions.lastHeartbeatAt, cutoff)
			)
		);
}

function toD1Statement(
	ctx: ServiceCtx,
	query: Readonly<{ sql: string; params: unknown[] }>
): D1PreparedStatement {
	return ctx.db.prepare(query.sql).bind(...query.params);
}

// Multi-row insert chunk size for agent_messages (6 columns/row), calibrated for D1's
// 100-bound-param cap with headroom — unlike services/sql.ts#inChunks, which is calibrated
// for single-param IN-list queries, not multi-column inserts.
const MESSAGE_INSERT_CHUNK_SIZE = 10;

// PROJ-864: batched variant of postMessage for callers that fold several coordination
// messages into their own db.batch() (e.g. file-claims' force-override notifications).
// Unlike postMessage, this does NOT re-validate scope/agentId against the workspace and
// does not read the inserted rows back — every field here is server-generated from data
// the caller already resolved and validated for its own use (the issueId(s) the scopes
// name), so there's nothing untrusted to check and nothing DB-generated to read back.
export function buildPostMessageStatements(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	messages: readonly Readonly<{ scope: string; agentId?: string; body: string }>[]
): D1PreparedStatement[] {
	if (messages.length === 0) return [];
	const now = Date.now();
	const rows = messages.map((m) => ({
		id: crypto.randomUUID(),
		workspaceId: ctx.workspaceId,
		scope: m.scope,
		agentId: m.agentId ?? null,
		body: m.body,
		createdAt: now,
	}));
	const statements: D1PreparedStatement[] = [];
	for (let i = 0; i < rows.length; i += MESSAGE_INSERT_CHUNK_SIZE) {
		const chunk = rows.slice(i, i + MESSAGE_INSERT_CHUNK_SIZE);
		statements.push(toD1Statement(ctx, orm.insert(schema.agentMessages).values(chunk).toSQL()));
	}
	return statements;
}

export async function postMessage(ctx: ServiceCtx, raw: unknown) {
	const result = PostMessageSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { agentId, body } = result.data;
	// PROJ-959: "issue:PROJ-42" is stored (and read) as "issue:<uuid>", so a ref and a UUID
	// name the same channel.
	const scope = await resolveMessageScope(ctx, result.data.scope);

	const orm = drizzle(ctx.db, { schema });

	// If scope is an issue scope, verify the issue belongs to this workspace
	if (scope.startsWith("issue:")) {
		const issueId = scope.slice("issue:".length);
		const issue = await orm
			.select({ id: schema.issues.id })
			.from(schema.issues)
			.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, ctx.workspaceId)))
			.get();
		if (!issue) throw new NotFoundError("Issue not found");
	}

	// If agentId given, verify the agent session belongs to this workspace
	if (agentId) {
		const agent = await orm
			.select({ id: schema.agentSessions.id })
			.from(schema.agentSessions)
			.where(
				and(
					eq(schema.agentSessions.id, agentId),
					eq(schema.agentSessions.workspaceId, ctx.workspaceId)
				)
			)
			.get();
		if (!agent) throw new NotFoundError("Agent session not found");

		// PROJ-929: refresh the poster's heartbeat, live sessions only.
		await touchAgentHeartbeatIfLive(orm, ctx, agentId);
	}

	const id = crypto.randomUUID();
	// Millisecond precision: ensures unique ordering for messages posted in rapid
	// succession (e.g., multiple SELF.fetch calls in tests within the same second).
	const now = Date.now();

	await orm.insert(schema.agentMessages).values({
		id,
		workspaceId: ctx.workspaceId,
		scope,
		agentId: agentId ?? null,
		body,
		createdAt: now,
	});

	const row = await orm
		.select()
		.from(schema.agentMessages)
		.where(eq(schema.agentMessages.id, id))
		.get();

	// biome-ignore lint/style/noNonNullAssertion: row was just inserted; SELECT immediately after guarantees it exists
	return row!;
}

export async function listMessages(ctx: ServiceCtx, raw: unknown) {
	const result = ListMessagesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { cursor, limit } = result.data;
	const scope = await resolveMessageScope(ctx, result.data.scope, { lenient: true });

	const orm = drizzle(ctx.db, { schema });

	// Composite cursor: "createdAt:id" — stable even when multiple messages share
	// the same second-precision timestamp.
	let cursorFilter: ReturnType<typeof and> | undefined;
	if (cursor !== undefined) {
		const sep = cursor.lastIndexOf(":");
		const cursorTime = parseInt(cursor.slice(0, sep), 10);
		const cursorId = cursor.slice(sep + 1);
		cursorFilter = and(
			eq(schema.agentMessages.workspaceId, ctx.workspaceId),
			eq(schema.agentMessages.scope, scope),
			// Next page: rows strictly after (cursorTime, cursorId) in ASC order
			// (createdAt > cursorTime) OR (createdAt = cursorTime AND id > cursorId)
			sql`(${schema.agentMessages.createdAt} > ${cursorTime} OR
				(${schema.agentMessages.createdAt} = ${cursorTime} AND ${schema.agentMessages.id} > ${cursorId}))`
		);
	}

	const rows = await orm
		.select()
		.from(schema.agentMessages)
		.where(
			cursorFilter ??
				and(
					eq(schema.agentMessages.workspaceId, ctx.workspaceId),
					eq(schema.agentMessages.scope, scope)
				)
		)
		.orderBy(asc(schema.agentMessages.createdAt), asc(schema.agentMessages.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const lastItem = items[items.length - 1] as { createdAt: number; id: string } | undefined;
	const nextCursor = hasMore && lastItem ? `${lastItem.createdAt}:${lastItem.id}` : null;

	return { items, nextCursor };
}
