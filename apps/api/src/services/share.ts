import { NotFoundError } from "./errors";
import type { ServiceCtx } from "./types";

async function hashToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function createShareToken(
	ctx: ServiceCtx,
	issueId: string
): Promise<{ token: string; url: string }> {
	const now = Math.floor(Date.now() / 1000);

	// Verify the issue belongs to this workspace
	const issue = await ctx.db
		.prepare("SELECT id FROM issues WHERE id = ? AND workspace_id = ?")
		.bind(issueId, ctx.workspaceId)
		.first<{ id: string }>();
	if (!issue) throw new NotFoundError("Issue not found");

	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const expiresAt = now + 3 * 86400;

	// share_tokens.id stores sha256(token), never the raw token — see PROJ-239
	const id = await hashToken(token);
	await ctx.db
		.prepare(
			"INSERT INTO share_tokens (id, issue_id, workspace_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
		)
		.bind(id, issueId, ctx.workspaceId, ctx.userId, expiresAt, now)
		.run();

	return { token, url: `/share/${token}` };
}

interface SharedIssueRow {
	title: string;
	body: string | null;
	priority: string;
	status_name: string | null;
	status_category: string | null;
	project_key: string | null;
	project_name: string | null;
	assignee_name: string | null;
	created_at: number;
	expires_at: number;
}

export async function getSharedIssue(
	db: D1Database,
	token: string
): Promise<
	SharedIssueRow & {
		customFields: Array<{ key: string; label: string; type: string; value: string }>;
	}
> {
	const now = Math.floor(Date.now() / 1000);
	const id = await hashToken(token);

	const row = await db
		.prepare(
			`SELECT
        i.title, i.body, i.priority, i.created_at,
        ts.name AS status_name, ts.category AS status_category,
        p.key AS project_key, p.name AS project_name,
        u.name AS assignee_name,
        st.expires_at
      FROM share_tokens st
      JOIN issues i ON i.id = st.issue_id
      LEFT JOIN task_statuses ts ON ts.id = i.status_id
      LEFT JOIN projects p ON p.id = i.project_id
      LEFT JOIN users u ON u.id = i.assignee_id
      WHERE st.id = ? AND st.expires_at > ?`
		)
		.bind(id, now)
		.first<SharedIssueRow>();

	if (!row) throw new NotFoundError("Share link not found or expired");

	const tokenMeta = await db
		.prepare("SELECT issue_id FROM share_tokens WHERE id = ?")
		.bind(id)
		.first<{ issue_id: string }>();

	if (!tokenMeta) throw new NotFoundError("Share link not found or expired");

	const cfRows = await db
		.prepare(
			`SELECT cfd.key, cfd.label, cfd.type, cfv.value
       FROM custom_field_values cfv
       JOIN custom_field_definitions cfd ON cfd.id = cfv.field_id
       WHERE cfv.issue_id = ?`
		)
		.bind(tokenMeta.issue_id)
		.all<{ key: string; label: string; type: string; value: string }>();

	return { ...row, customFields: cfRows.results ?? [] };
}
