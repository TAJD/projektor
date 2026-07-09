import { drizzle, schema } from "@projektor/db";
import type { Role } from "@projektor/types";
import { and, type Column, eq, type SQL, sql } from "drizzle-orm";
import { NotFoundError } from "./errors";
import type { ServiceCtx } from "./types";

// PROJ-311: group-based project access.
//
// Authorization model: workspace owner/admin see and can do everything (they
// bypass groups — this preserves the ADMIN_EMAILS bootstrap and makes lockout
// impossible). Every other member is default-deny: a project is visible only if
// one of the user's groups holds a grant on it, and the grant's role — not the
// member's workspace role — governs what they can do inside that project.
//
// Visibility is computed per-request from an indexed join
// (user_group_members ⋈ group_project_grants); there is no session state, so a
// membership change takes effect on the user's very next request.

export function isWorkspaceAdmin(role: Role | undefined): boolean {
	return role === "owner" || role === "admin";
}

// Grant roles, weakest → strongest. A user in several groups with grants on the
// same project gets the strongest.
const PROJECT_ROLE_RANK: Record<"viewer" | "member" | "admin", number> = {
	viewer: 1,
	member: 2,
	admin: 3,
};

function strongestGrant(roles: ("viewer" | "member" | "admin")[]): "viewer" | "member" | "admin" {
	return roles.reduce((best, r) => (PROJECT_ROLE_RANK[r] > PROJECT_ROLE_RANK[best] ? r : best));
}

/**
 * The effective role a user has *inside* a given project.
 * - owner/admin → their workspace role (full access everywhere).
 * - otherwise   → the strongest grant across the user's groups for that project,
 *                 or `null` when no group grants access (default-deny).
 *
 * The caller is expected to have already confirmed the project belongs to the
 * workspace (grants only ever reference in-workspace projects, so a project id
 * match is sufficient here).
 */
export async function effectiveProjectRole(
	ctx: ServiceCtx,
	projectId: string
): Promise<Role | null> {
	if (isWorkspaceAdmin(ctx.role)) return ctx.role ?? null;

	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({ role: schema.groupProjectGrants.role })
		.from(schema.groupProjectGrants)
		.innerJoin(
			schema.userGroupMembers,
			eq(schema.userGroupMembers.groupId, schema.groupProjectGrants.groupId)
		)
		.where(
			and(
				eq(schema.userGroupMembers.userId, ctx.userId),
				eq(schema.groupProjectGrants.projectId, projectId)
			)
		);

	if (rows.length === 0) return null;
	return strongestGrant(rows.map((r) => r.role));
}

/**
 * Resolve the effective project role, throwing `NotFoundError` when the user has
 * no access. Invisible projects 404 rather than 403 so their existence never
 * leaks to a member who was never granted them. `notFoundMessage` lets callers
 * keep their own resource's not-found wording (e.g. "Issue not found") instead
 * of leaking "Project not found" for a different resource type.
 */
export async function requireProjectAccess(
	ctx: ServiceCtx,
	projectId: string,
	notFoundMessage = "Project not found"
): Promise<Role> {
	const role = await effectiveProjectRole(ctx, projectId);
	if (role === null) throw new NotFoundError(notFoundMessage);
	return role;
}

/** True when the effective project role permits mutations (member/admin/owner, not viewer). */
export function canWriteProject(role: Role): boolean {
	return role !== "viewer";
}

/**
 * A drizzle `EXISTS(...)` predicate that keeps only projects visible to the user,
 * for use in a list query's WHERE clause. Returns `undefined` for workspace
 * owner/admin (they see everything, so no filter is applied).
 *
 * `projectColumn` is the column the outer query exposes as the project id
 * (e.g. `schema.projects.id`, `schema.issues.projectId`).
 */
export function visibleProjectPredicate(
	ctx: ServiceCtx,
	projectColumn: Column | SQL
): SQL | undefined {
	if (isWorkspaceAdmin(ctx.role)) return undefined;
	return sql`EXISTS (
		SELECT 1 FROM user_group_members ugm
		JOIN group_project_grants gpg ON gpg.group_id = ugm.group_id
		WHERE ugm.user_id = ${ctx.userId} AND gpg.project_id = ${projectColumn}
	)`;
}

/**
 * The raw-SQL twin of `visibleProjectPredicate`, for services that hand-write SQL
 * (FTS search, flow metrics, cross-table aggregates). Returns a SQL fragment plus
 * its bind params, or `null` for owner/admin (no filter needed).
 *
 * `projectColExpr` is inlined verbatim, so it MUST be a trusted column reference
 * (e.g. `"i.project_id"`), never user input. It is validated as a bare or
 * table-qualified identifier and throws otherwise, so a future caller can't turn
 * this into an injection vector by passing something dynamic.
 */
const COLUMN_EXPR = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export function visibleProjectSqlFragment(
	ctx: ServiceCtx,
	projectColExpr: string
): { sql: string; params: unknown[] } | null {
	if (!COLUMN_EXPR.test(projectColExpr)) {
		throw new Error(
			`visibleProjectSqlFragment: projectColExpr must be a column identifier, got ${JSON.stringify(projectColExpr)}`
		);
	}
	if (isWorkspaceAdmin(ctx.role)) return null;
	return {
		sql: `EXISTS (SELECT 1 FROM user_group_members ugm
			JOIN group_project_grants gpg ON gpg.group_id = ugm.group_id
			WHERE ugm.user_id = ? AND gpg.project_id = ${projectColExpr})`,
		params: [ctx.userId],
	};
}
