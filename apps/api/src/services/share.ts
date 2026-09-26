import { assertProjectAccess, usersWithProjectReadAccess } from "./access";
import { NotFoundError } from "./errors";
import type { ServiceCtx } from "./types";
import {
	getWorkspaceBrandForShare,
	getWorkspaceBrandLogoR2Key,
	type WorkspaceBrandDto,
} from "./workspaces";

async function hashToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * PROJ-792: creating or revoking a public link needs *edit* access to the
 * issue's project (group grant, or workspace owner/admin) — not merely a
 * non-viewer workspace role. No access → 404 (hides existence); read-only → 403.
 */
async function assertIssueShareable(ctx: ServiceCtx, issueId: string): Promise<void> {
	const issue = await ctx.db
		.prepare("SELECT project_id FROM issues WHERE id = ? AND workspace_id = ?")
		.bind(issueId, ctx.workspaceId)
		.first<{ project_id: string }>();
	if (!issue) throw new NotFoundError("Issue not found");
	await assertProjectAccess(ctx, issue.project_id, "edit", {
		notFoundMessage: "Issue not found",
		projectLoadedFromWorkspaceRow: true,
	});
}

export async function createShareToken(
	ctx: ServiceCtx,
	issueId: string
): Promise<{ token: string; url: string }> {
	await assertIssueShareable(ctx, issueId);

	const now = Math.floor(Date.now() / 1000);

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

/**
 * PROJ-794: a share token resolves only while all of these hold, checked on every read
 * (not by deleting tokens when access changes, so group edits, grant revokes and member
 * removals are all covered with no fan-out):
 * - the token hasn't expired;
 * - its issue still exists (issues are hard-deleted, so a deleted one fails the join)
 *   and the issue's project isn't archived (issues have no archive state of their own);
 * - the token's creator can still read the issue's project — still a workspace member,
 *   and a workspace owner/admin or a member whose group holds a grant on it.
 */
async function resolveLiveShareToken(
	db: D1Database,
	tokenHash: string
): Promise<{ issueId: string; workspaceId: string } | null> {
	const now = Math.floor(Date.now() / 1000);
	const row = await db
		.prepare(
			`SELECT st.issue_id, st.workspace_id, st.created_by, i.project_id
       FROM share_tokens st
       JOIN issues i ON i.id = st.issue_id AND i.workspace_id = st.workspace_id
       JOIN projects p ON p.id = i.project_id AND p.workspace_id = st.workspace_id
       WHERE st.id = ? AND st.expires_at > ?
         AND p.archived_at IS NULL`
		)
		.bind(tokenHash, now)
		.first<{ issue_id: string; workspace_id: string; created_by: string; project_id: string }>();
	if (!row) return null;

	const allowed = await usersWithProjectReadAccess(
		{ db, workspaceId: row.workspace_id },
		row.project_id,
		[row.created_by]
	);
	if (!allowed.has(row.created_by)) return null;
	return { issueId: row.issue_id, workspaceId: row.workspace_id };
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
	workspace_id: string;
	workspace_slug: string;
}

export async function getSharedIssue(
	db: D1Database,
	token: string
): Promise<
	Omit<SharedIssueRow, "workspace_id" | "workspace_slug"> & {
		customFields: Array<{ key: string; label: string; type: string; value: string }>;
		brand: WorkspaceBrandDto;
	}
> {
	const id = await hashToken(token);
	const live = await resolveLiveShareToken(db, id);
	if (!live) throw new NotFoundError("Share link not found or expired");

	const row = await db
		.prepare(
			`SELECT
        i.title, i.body, i.priority, i.created_at,
        ts.name AS status_name, ts.category AS status_category,
        p.key AS project_key, p.name AS project_name,
        u.name AS assignee_name,
        st.expires_at,
        st.workspace_id AS workspace_id,
        w.slug AS workspace_slug
      FROM share_tokens st
      JOIN issues i ON i.id = st.issue_id
      JOIN workspaces w ON w.id = st.workspace_id
      LEFT JOIN task_statuses ts ON ts.id = i.status_id
      LEFT JOIN projects p ON p.id = i.project_id
      LEFT JOIN users u ON u.id = i.assignee_id
      WHERE st.id = ?`
		)
		.bind(id)
		.first<SharedIssueRow>();

	if (!row) throw new NotFoundError("Share link not found or expired");

	const cfRows = await db
		.prepare(
			`SELECT cfd.key, cfd.label, cfd.type, cfv.value
       FROM custom_field_values cfv
       JOIN custom_field_definitions cfd ON cfd.id = cfv.field_id
       WHERE cfv.issue_id = ? AND cfd.is_internal = 0`
		)
		.bind(live.issueId)
		.all<{ key: string; label: string; type: string; value: string }>();

	const brandDto = await getWorkspaceBrandForShare(db, row.workspace_id, row.workspace_slug);
	const brand = brandDto.logoUrl ? { ...brandDto, logoUrl: `/api/share/${token}/logo` } : brandDto;
	const { workspace_id, workspace_slug, ...rest } = row;

	return { ...rest, customFields: cfRows.results ?? [], brand };
}

export async function getSharedLogo(
	db: D1Database,
	r2: R2Bucket,
	token: string
): Promise<R2ObjectBody | null> {
	const live = await resolveLiveShareToken(db, await hashToken(token));
	if (!live) return null;

	const r2Key = await getWorkspaceBrandLogoR2Key(db, live.workspaceId);
	if (!r2Key) return null;

	return r2.get(r2Key);
}

export async function revokeShareToken(ctx: ServiceCtx, issueId: string): Promise<void> {
	await assertIssueShareable(ctx, issueId);

	await ctx.db
		.prepare("DELETE FROM share_tokens WHERE issue_id = ? AND workspace_id = ?")
		.bind(issueId, ctx.workspaceId)
		.run();
}
