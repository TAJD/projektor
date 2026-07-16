import {
	CreateFeedbackSourceSchema,
	ListFeedbackSourcesSchema,
	RevokeFeedbackSourceSchema,
	RotateFeedbackSourceSchema,
	UpdateFeedbackSourceSchema,
} from "../schemas/feedback";
import { isWorkspaceAdmin, requireProjectInWorkspace } from "./access";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

export interface FeedbackSourceView {
	id: string;
	name: string;
	description: string | null;
	isActive: boolean;
	allowedOrigins: string[] | null;
	tokenPreview: string;
	createdAt: number;
	revokedAt: number | null;
}

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function newRawToken(): string {
	return `fbk_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

interface SourceRow {
	id: string;
	token_hash: string;
	name: string;
	description: string | null;
	is_active: number;
	allowed_origins: string | null;
	created_at: number;
	revoked_at: number | null;
}

// Resolve a source scoped to the workspace (404 before any role check). Management
// ops take only a sourceId; the project is resolved from the source row.
async function requireSource(ctx: ServiceCtx, sourceId: string): Promise<SourceRow> {
	const row = await ctx.db
		.prepare(
			`SELECT id, token_hash, name, description, is_active, allowed_origins, created_at, revoked_at
       FROM feedback_sources WHERE id = ? AND workspace_id = ?`
		)
		.bind(sourceId, ctx.workspaceId)
		.first<SourceRow>();
	if (!row) throw new NotFoundError("Feedback source not found");
	return row;
}

export async function createFeedbackSource(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ id: string; token: string }> {
	const parsed = CreateFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, name, description, allowedOrigins } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const token = newRawToken();
	const tokenHash = await sha256hex(token);
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await ctx.db
		.prepare(
			`INSERT INTO feedback_sources
       (id, token_hash, workspace_id, project_id, name, description, is_active, allowed_origins, created_by, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`
		)
		.bind(
			id,
			tokenHash,
			ctx.workspaceId,
			projectId,
			name,
			description ?? null,
			allowedOrigins ? JSON.stringify(allowedOrigins) : null,
			ctx.userId,
			now
		)
		.run();

	return { id, token };
}

export async function listFeedbackSources(
	ctx: ServiceCtx,
	input: unknown
): Promise<FeedbackSourceView[]> {
	const parsed = ListFeedbackSourcesSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const { results } = await ctx.db
		.prepare(
			`SELECT id, token_hash, name, description, is_active, allowed_origins, created_at, revoked_at
       FROM feedback_sources WHERE project_id = ? AND workspace_id = ? ORDER BY created_at DESC`
		)
		.bind(projectId, ctx.workspaceId)
		.all<SourceRow>();

	return (results ?? []).map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		isActive: r.is_active === 1,
		allowedOrigins: r.allowed_origins ? (JSON.parse(r.allowed_origins) as string[]) : null,
		tokenPreview: `${r.token_hash.slice(0, 12)}…`,
		createdAt: r.created_at,
		revokedAt: r.revoked_at,
	}));
}

export async function updateFeedbackSource(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }> {
	const parsed = UpdateFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { sourceId, name, description, isActive } = parsed.data;

	await requireSource(ctx, sourceId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const sets: string[] = [];
	const binds: unknown[] = [];
	if (name !== undefined) {
		sets.push("name = ?");
		binds.push(name);
	}
	if (description !== undefined) {
		sets.push("description = ?");
		binds.push(description);
	}
	if (isActive !== undefined) {
		sets.push("is_active = ?");
		binds.push(isActive ? 1 : 0);
	}
	binds.push(sourceId, ctx.workspaceId);

	await ctx.db
		.prepare(`UPDATE feedback_sources SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`)
		.bind(...binds)
		.run();

	return { ok: true };
}

export async function rotateFeedbackSourceToken(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ token: string }> {
	const parsed = RotateFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { sourceId } = parsed.data;

	await requireSource(ctx, sourceId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const token = newRawToken();
	const tokenHash = await sha256hex(token);
	await ctx.db
		.prepare("UPDATE feedback_sources SET token_hash = ? WHERE id = ? AND workspace_id = ?")
		.bind(tokenHash, sourceId, ctx.workspaceId)
		.run();

	return { token };
}

export async function revokeFeedbackSource(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }> {
	const parsed = RevokeFeedbackSourceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { sourceId } = parsed.data;

	await requireSource(ctx, sourceId);
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError("Insufficient permissions");

	const now = Math.floor(Date.now() / 1000);
	await ctx.db
		.prepare("UPDATE feedback_sources SET revoked_at = ? WHERE id = ? AND workspace_id = ?")
		.bind(now, sourceId, ctx.workspaceId)
		.run();

	return { ok: true };
}
