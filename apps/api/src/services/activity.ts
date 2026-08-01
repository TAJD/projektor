import { drizzle, schema } from "@projektor/db";
import type { ServiceCtx } from "./types";

export async function recordActivity(
	ctx: ServiceCtx,
	opts: Readonly<{
		entityType: "issue" | "wiki_page" | "project" | "group";
		entityId: string;
		action: "created" | "updated" | "deleted";
		diff?: Record<string, unknown>;
	}>
): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	await orm.insert(schema.activity).values({
		id: crypto.randomUUID(),
		workspaceId: ctx.workspaceId,
		entityType: opts.entityType,
		entityId: opts.entityId,
		actorId: ctx.userId,
		action: opts.action,
		diff: opts.diff ?? null,
		createdAt: Math.floor(Date.now() / 1000),
	});
}
