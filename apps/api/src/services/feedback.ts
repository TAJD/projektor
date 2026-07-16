import {
	ListFeedbackSchema,
	SubmitFeedbackSchema,
	UpdateFeedbackSchema,
} from "../schemas/feedback";
import { canWriteProject, requireProjectAccess } from "./access";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

export async function hashFeedbackToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

interface SubmitSourceRow {
	id: string;
	workspace_id: string;
	project_id: string;
	is_active: number;
	allowed_origins: string | null;
	revoked_at: number | null;
}

export async function submitFeedback(
	db: D1Database,
	token: string,
	rawBody: unknown,
	requestOrigin: string | null
): Promise<{ id: string; corsAllowOrigin: string | null }> {
	const tokenHash = await hashFeedbackToken(token);
	const source = await db
		.prepare(
			`SELECT id, workspace_id, project_id, is_active, allowed_origins, revoked_at
       FROM feedback_sources WHERE token_hash = ?`
		)
		.bind(tokenHash)
		.first<SubmitSourceRow>();

	// Unknown or revoked → treated as an invalid credential (route maps NotFound → 401).
	if (!source || source.revoked_at !== null) throw new NotFoundError("Invalid feedback token");
	// Inactive → the credential is real but the source is paused (kill switch) → 403.
	if (source.is_active !== 1) throw new ForbiddenError("Feedback source is inactive");

	const parsed = SubmitFeedbackSchema.safeParse(rawBody);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const d = parsed.data;

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare(
			`INSERT INTO feedback
       (id, source_id, workspace_id, project_id, rating, rating_scale, body, submitter_label, source_url, app_version, status, linked_issue_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?)`
		)
		.bind(
			id,
			source.id,
			source.workspace_id,
			source.project_id,
			d.rating ?? null,
			d.ratingScale ?? null,
			d.body ?? null,
			d.submitterLabel ?? null,
			d.sourceUrl ?? null,
			d.appVersion ?? null,
			now
		)
		.run();

	const allowed = source.allowed_origins ? (JSON.parse(source.allowed_origins) as string[]) : null;
	const corsAllowOrigin =
		allowed && requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : null;

	return { id, corsAllowOrigin };
}

export interface FeedbackView {
	id: string;
	sourceId: string;
	sourceName: string | null;
	rating: number | null;
	ratingScale: string | null;
	body: string | null;
	submitterLabel: string | null;
	sourceUrl: string | null;
	appVersion: string | null;
	status: string;
	linkedIssueId: string | null;
	createdAt: number;
}

interface FeedbackJoinRow {
	id: string;
	source_id: string;
	source_name: string | null;
	rating: number | null;
	rating_scale: string | null;
	body: string | null;
	submitter_label: string | null;
	source_url: string | null;
	app_version: string | null;
	status: string;
	linked_issue_id: string | null;
	created_at: number;
}

// Mirrors feedback-sources.ts: requireProjectAccess alone doesn't confirm the
// project belongs to ctx.workspaceId (workspace admins bypass group grants
// entirely), so a cross-workspace owner/admin would otherwise pass. Confirm
// workspace membership first.
async function requireProjectInWorkspace(ctx: ServiceCtx, projectId: string): Promise<void> {
	const project = await ctx.db
		.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?")
		.bind(projectId, ctx.workspaceId)
		.first<{ id: string }>();
	if (!project) throw new NotFoundError("Project not found");
}

export async function listFeedback(ctx: ServiceCtx, input: unknown): Promise<FeedbackView[]> {
	const parsed = ListFeedbackSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, status, sourceId } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	await requireProjectAccess(ctx, projectId);

	const clauses = ["f.project_id = ?", "f.workspace_id = ?"];
	const binds: unknown[] = [projectId, ctx.workspaceId];
	if (status) {
		clauses.push("f.status = ?");
		binds.push(status);
	}
	if (sourceId) {
		clauses.push("f.source_id = ?");
		binds.push(sourceId);
	}

	const { results } = await ctx.db
		.prepare(
			`SELECT f.id, f.source_id, s.name AS source_name, f.rating, f.rating_scale, f.body,
            f.submitter_label, f.source_url, f.app_version, f.status, f.linked_issue_id, f.created_at
       FROM feedback f
       LEFT JOIN feedback_sources s ON s.id = f.source_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY f.created_at DESC`
		)
		.bind(...binds)
		.all<FeedbackJoinRow>();

	return (results ?? []).map((r) => ({
		id: r.id,
		sourceId: r.source_id,
		sourceName: r.source_name,
		rating: r.rating,
		ratingScale: r.rating_scale,
		body: r.body,
		submitterLabel: r.submitter_label,
		sourceUrl: r.source_url,
		appVersion: r.app_version,
		status: r.status,
		linkedIssueId: r.linked_issue_id,
		createdAt: r.created_at,
	}));
}

export async function updateFeedbackStatus(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }> {
	const parsed = UpdateFeedbackSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, feedbackId, status } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	const role = await requireProjectAccess(ctx, projectId);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");

	const row = await ctx.db
		.prepare("SELECT id FROM feedback WHERE id = ? AND project_id = ? AND workspace_id = ?")
		.bind(feedbackId, projectId, ctx.workspaceId)
		.first<{ id: string }>();
	if (!row) throw new NotFoundError("Feedback not found");

	await ctx.db
		.prepare("UPDATE feedback SET status = ? WHERE id = ? AND workspace_id = ?")
		.bind(status, feedbackId, ctx.workspaceId)
		.run();

	return { ok: true };
}
