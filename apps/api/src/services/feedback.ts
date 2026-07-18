import {
	BulkFeedbackIdsSchema,
	ConvertFeedbackSchema,
	ListFeedbackSchema,
	SubmitFeedbackSchema,
	UpdateFeedbackSchema,
} from "../schemas/feedback";
import { canWriteProject, requireProjectAccess, requireProjectInWorkspace } from "./access";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { createIssue } from "./issues";
import { inChunks } from "./sql";
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

function ratingLabel(rating: number | null, scale: string | null): string {
	if (rating === null) return "Rating";
	if (scale === "thumbs") return rating > 0 ? "👍 Positive" : "👎 Negative";
	return `${rating}★`;
}

interface ConvertFeedbackRow {
	rating: number | null;
	rating_scale: string | null;
	body: string | null;
	submitter_label: string | null;
	status: string;
	linked_issue_id: string | null;
}

export async function convertFeedbackToIssue(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ id: string; number?: number }> {
	const parsed = ConvertFeedbackSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, feedbackId } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	const role = await requireProjectAccess(ctx, projectId);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");

	const fb = await ctx.db
		.prepare(
			`SELECT rating, rating_scale, body, submitter_label, status, linked_issue_id
       FROM feedback WHERE id = ? AND project_id = ? AND workspace_id = ?`
		)
		.bind(feedbackId, projectId, ctx.workspaceId)
		.first<ConvertFeedbackRow>();
	if (!fb) throw new NotFoundError("Feedback not found");
	// Already converted — reject re-conversion rather than silently creating a
	// second issue or re-linking; the caller should follow the existing linked issue.
	if (fb.linked_issue_id) throw new ConflictError("Feedback already converted to an issue");

	const title = fb.body
		? fb.body.slice(0, 120)
		: `${ratingLabel(fb.rating, fb.rating_scale)} feedback`;
	const footer =
		`— submitted via feedback source${fb.submitter_label ? ` by ${fb.submitter_label}` : ""}` +
		(fb.rating !== null ? `, rating: ${fb.rating} (${fb.rating_scale})` : "");

	const issue = await createIssue(ctx, {
		projectId,
		title,
		body: [fb.body ?? "", "", footer].join("\n"),
		priority: "medium",
	});

	await ctx.db
		.prepare(
			"UPDATE feedback SET linked_issue_id = ?, status = 'actioned' WHERE id = ? AND workspace_id = ?"
		)
		.bind(issue.id, feedbackId, ctx.workspaceId)
		.run();

	return issue;
}

export async function bulkMarkReviewed(
	ctx: ServiceCtx,
	input: unknown
): Promise<{ updated: number }> {
	const parsed = BulkFeedbackIdsSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, feedbackIds } = parsed.data;

	await requireProjectInWorkspace(ctx, projectId);
	const role = await requireProjectAccess(ctx, projectId);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");

	let updated = 0;
	await inChunks(feedbackIds, async (chunk) => {
		const placeholders = chunk.map(() => "?").join(", ");
		const result = await ctx.db
			.prepare(
				`UPDATE feedback SET status = 'reviewed'
         WHERE id IN (${placeholders}) AND project_id = ? AND workspace_id = ?`
			)
			.bind(...chunk, projectId, ctx.workspaceId)
			.run();
		updated += result.meta.changes;
		return [];
	});

	return { updated };
}

export interface FeedbackVersionSummary {
	appVersion: string | null;
	totalCount: number;
	withCommentCount: number;
	thumbsUpPct: number | null;
	avgFiveStar: number | null;
	lastSeenAt: number;
}

export interface FeedbackSourceSummary {
	sourceId: string;
	sourceName: string | null;
	totalCount: number;
	versions: FeedbackVersionSummary[];
}

interface FeedbackSummaryRow {
	source_id: string;
	source_name: string | null;
	app_version: string | null;
	total: number;
	thumbs_up: number;
	thumbs_total: number;
	five_star_avg: number | null;
	five_star_total: number;
	with_comment_count: number;
	last_seen_at: number;
}

export async function getFeedbackSummary(
	ctx: ServiceCtx,
	input: { projectId: string }
): Promise<FeedbackSourceSummary[]> {
	const { projectId } = input;

	await requireProjectInWorkspace(ctx, projectId);
	await requireProjectAccess(ctx, projectId);

	const { results } = await ctx.db
		.prepare(
			`SELECT
         f.source_id, s.name AS source_name, f.app_version,
         COUNT(*) AS total,
         SUM(CASE WHEN f.rating_scale = 'thumbs' AND f.rating > 0 THEN 1 ELSE 0 END) AS thumbs_up,
         SUM(CASE WHEN f.rating_scale = 'thumbs' THEN 1 ELSE 0 END) AS thumbs_total,
         AVG(CASE WHEN f.rating_scale = 'five_star' THEN f.rating END) AS five_star_avg,
         SUM(CASE WHEN f.rating_scale = 'five_star' THEN 1 ELSE 0 END) AS five_star_total,
         SUM(CASE WHEN f.body IS NOT NULL AND f.body != '' THEN 1 ELSE 0 END) AS with_comment_count,
         MAX(f.created_at) AS last_seen_at
       FROM feedback f
       LEFT JOIN feedback_sources s ON s.id = f.source_id
       WHERE f.project_id = ? AND f.workspace_id = ?
       GROUP BY f.source_id, f.app_version
       ORDER BY last_seen_at DESC`
		)
		.bind(projectId, ctx.workspaceId)
		.all<FeedbackSummaryRow>();

	const bySource = new Map<string, FeedbackSourceSummary>();
	for (const r of results ?? []) {
		let src = bySource.get(r.source_id);
		if (!src) {
			src = { sourceId: r.source_id, sourceName: r.source_name, totalCount: 0, versions: [] };
			bySource.set(r.source_id, src);
		}
		src.totalCount += r.total;
		src.versions.push({
			appVersion: r.app_version,
			totalCount: r.total,
			withCommentCount: r.with_comment_count,
			thumbsUpPct: r.thumbs_total > 0 ? Math.round((r.thumbs_up / r.thumbs_total) * 100) : null,
			avgFiveStar: r.five_star_total > 0 ? r.five_star_avg : null,
			lastSeenAt: r.last_seen_at,
		});
	}
	return Array.from(bySource.values());
}
