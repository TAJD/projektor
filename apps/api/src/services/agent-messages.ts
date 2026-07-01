import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { ListMessagesSchema, PostMessageSchema } from "../schemas/agent-messages";
import { NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

export async function postMessage(ctx: ServiceCtx, raw: unknown) {
	const result = PostMessageSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { scope, agentId, body } = result.data;

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
	const { scope, cursor, limit } = result.data;

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
			sql`(${schema.agentMessages.createdAt} > ${cursorTime} OR (${schema.agentMessages.createdAt} = ${cursorTime} AND ${schema.agentMessages.id} > ${cursorId}))`
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
