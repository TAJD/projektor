import { drizzle, schema } from "@projektor/db";
import { and, asc, desc, eq, gte, type SQL, sql } from "drizzle-orm";
import { ListMessagesSchema, PostMessageSchema } from "../schemas/agent-messages";
import { NotFoundError, ValidationError } from "./errors";
import { buildTouchAgentHeartbeatStatement } from "./issue-leases";
import { resolveMessageScope } from "./issue-ref";
import type { ServiceCtx } from "./types";

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

export function buildGuardedMessageInsert(
	ctx: ServiceCtx,
	message: Readonly<{ scope: string; agentId: string | null; body: string }>,
	guard: Readonly<{ sql: string; params: unknown[] }>
): { statement: D1PreparedStatement; row: typeof schema.agentMessages.$inferSelect } {
	const row = {
		id: crypto.randomUUID(),
		workspaceId: ctx.workspaceId,
		scope: message.scope,
		agentId: message.agentId,
		body: message.body,
		createdAt: Date.now(),
	};
	const statement = ctx.db
		.prepare(
			`INSERT INTO agent_messages (id, workspace_id, scope, agent_id, body, created_at)
			 SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`
		)
		.bind(
			row.id,
			row.workspaceId,
			row.scope,
			row.agentId,
			row.body,
			row.createdAt,
			...guard.params
		);
	return { statement, row };
}

export async function postMessage(ctx: ServiceCtx, raw: unknown) {
	const result = PostMessageSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { agentId, body } = result.data;
	const scope = await resolveMessageScope(ctx, result.data);

	const guard = agentId
		? {
				sql: "EXISTS (SELECT 1 FROM agent_sessions WHERE id = ? AND workspace_id = ?)",
				params: [agentId, ctx.workspaceId],
			}
		: { sql: "1 = 1", params: [] };
	const { statement, row } = buildGuardedMessageInsert(
		ctx,
		{ scope, agentId: agentId ?? null, body },
		guard
	);

	if (!agentId) {
		await statement.run();
		return row;
	}
	const results = await ctx.db.batch([buildTouchAgentHeartbeatStatement(ctx, agentId), statement]);
	if (results[1].meta.changes === 0) throw new NotFoundError("Agent session not found");
	return row;
}

export async function listMessages(ctx: ServiceCtx, raw: unknown) {
	const result = ListMessagesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { cursor, limit, order, since } = result.data;
	const scope = await resolveMessageScope(ctx, result.data, { lenient: true });

	const orm = drizzle(ctx.db, { schema });
	const messages = schema.agentMessages;

	const conditions: SQL[] = [eq(messages.workspaceId, ctx.workspaceId), eq(messages.scope, scope)];
	// created_at is milliseconds; `since` is unix seconds.
	if (since !== undefined) conditions.push(gte(messages.createdAt, since * 1000));
	if (cursor !== undefined) {
		const sep = cursor.lastIndexOf(":");
		const cursorTime = parseInt(cursor.slice(0, sep), 10);
		const cursorId = cursor.slice(sep + 1);
		const compare = sql.raw(order === "asc" ? ">" : "<");
		conditions.push(
			sql`(${messages.createdAt}, ${messages.id}) ${compare} (${cursorTime}, ${cursorId})`
		);
	}

	const direction = order === "asc" ? asc : desc;
	const rows = await orm
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(direction(messages.createdAt), direction(messages.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const lastItem = items[items.length - 1] as { createdAt: number; id: string } | undefined;
	const nextCursor = hasMore && lastItem ? `${lastItem.createdAt}:${lastItem.id}` : null;

	return { items, nextCursor };
}
