import { SubmitFeedbackSchema } from "../schemas/feedback";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";

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
