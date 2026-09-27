import { drizzle, schema } from "@projektor/db";
import type { Role } from "@projektor/types";
import { and, type Column, eq, inArray, type SQL, sql } from "drizzle-orm";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
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

function strongestGrant(
	roles: readonly ("viewer" | "member" | "admin")[]
): "viewer" | "member" | "admin" {
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
 * leaks to a member who was never granted them.
 */
export async function requireProjectAccess(ctx: ServiceCtx, projectId: string): Promise<Role> {
	const role = await effectiveProjectRole(ctx, projectId);
	if (role === null) throw new NotFoundError("Project not found");
	return role;
}

/** True when the effective project role permits mutations (member/admin/owner, not viewer). */
export function canWriteProject(role: Role): boolean {
	return role !== "viewer";
}

/**
 * Confirm `projectId` belongs to `ctx.workspaceId`, throwing `NotFoundError` otherwise.
 *
 * Unlike `effectiveProjectRole`/`requireProjectAccess` (which assume the
 * project-in-workspace check already happened and only resolve the caller's role
 * within it), this IS that check. It exists for admin-bypass codepaths — such as
 * issue/wiki creation — where owner/admin short-circuit past `effectiveProjectRole`
 * entirely, so nothing else confirms the caller-supplied `projectId` actually
 * belongs to their workspace before it gets stamped onto a new row.
 */
export async function requireProjectInWorkspace(ctx: ServiceCtx, projectId: string): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	const project = await orm
		.select({ id: schema.projects.id })
		.from(schema.projects)
		.where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!project) throw new NotFoundError("Project not found");
}

// ─── PROJ-837: the central access guard ─────────────────────────────────────
//
// One policy for every project-scoped resource (issue, wiki page, sprint,
// project, share link, …):
//
//   • no access at all  → 404 (NotFoundError). The resource's existence must not
//     leak to someone who was never granted its project.
//   • can see, can't write (mode "edit" with a viewer-level role) → 403
//     (ForbiddenError). They can already see it, so 404 would only confuse.
//   • project not in ctx.workspaceId → 404, for everyone including owner/admin
//     (PROJ-389 — the admin bypass must never cross a tenant boundary).
//
// New service code should call `assertProjectAccess` (single resource) or
// `hasProjectAccess` (a soft check that returns false instead of throwing, for
// "unknown project → empty list" read paths), and `visibleProjectFilter` for
// list queries. `test/architecture/access-guard.test.ts` enforces this.

export type AccessMode = "read" | "edit";

export interface AssertProjectAccessOptions {
	/** Message for the 404. Default "Not found" — name the resource the caller asked for. */
	notFoundMessage?: string;
	/**
	 * Skip the project-in-workspace query because the caller loaded `projectId`
	 * from a row it already fetched with `workspace_id = ctx.workspaceId`
	 * (projects.workspace_id is immutable, so the child row's project is in the
	 * same workspace). Never set this for a caller-supplied projectId.
	 */
	projectLoadedFromWorkspaceRow?: boolean;
}

/**
 * Throw unless the caller may `mode` the project. Returns the effective role.
 * See the policy block above for 404-vs-403.
 */
export async function assertProjectAccess(
	ctx: ServiceCtx,
	projectId: string,
	mode: AccessMode,
	opts: AssertProjectAccessOptions = {}
): Promise<Role> {
	const notFound = opts.notFoundMessage ?? "Not found";
	if (!opts.projectLoadedFromWorkspaceRow) {
		try {
			await requireProjectInWorkspace(ctx, projectId);
		} catch {
			throw new NotFoundError(notFound);
		}
	}
	const role = await effectiveProjectRole(ctx, projectId);
	if (role === null) throw new NotFoundError(notFound);
	if (mode === "edit" && !canWriteProject(role)) {
		throw new ForbiddenError("Insufficient permissions");
	}
	return role;
}

/**
 * Soft variant of `assertProjectAccess` for read paths where "no access" means
 * "return nothing" rather than an error (search/list scoped to a project).
 */
export async function hasProjectAccess(
	ctx: ServiceCtx,
	projectId: string,
	mode: AccessMode = "read"
): Promise<boolean> {
	if (isWorkspaceAdmin(ctx.role)) return true;
	const role = await effectiveProjectRole(ctx, projectId);
	if (role === null) return false;
	return mode === "read" || canWriteProject(role);
}

/**
 * List-query filter: keep only rows whose project the caller can see. Returns
 * `undefined` for owner/admin (no filter). Alias of `visibleProjectPredicate`
 * under the PROJ-837 name; defaults to filtering `projects.id`.
 */
export function visibleProjectFilter(
	ctx: ServiceCtx,
	projectColumn: Column | SQL = schema.projects.id
): SQL | undefined {
	return visibleProjectPredicate(ctx, projectColumn);
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

/**
 * Return every project ID visible to the caller inside their workspace.
 * - owner/admin: every project in the workspace.
 * - everyone else: the union of project grants held by the caller's groups
 *   (default-deny; scoped by workspace_id through both user_groups and projects).
 */
export async function visibleProjectIds(ctx: ServiceCtx): Promise<string[]> {
	const orm = drizzle(ctx.db, { schema });

	if (isWorkspaceAdmin(ctx.role)) {
		const rows = await orm
			.select({ id: schema.projects.id })
			.from(schema.projects)
			.where(eq(schema.projects.workspaceId, ctx.workspaceId))
			.all();
		return rows.map((r) => r.id);
	}

	const rows = await orm
		.selectDistinct({ id: schema.groupProjectGrants.projectId })
		.from(schema.groupProjectGrants)
		.innerJoin(
			schema.userGroupMembers,
			eq(schema.userGroupMembers.groupId, schema.groupProjectGrants.groupId)
		)
		.innerJoin(schema.userGroups, eq(schema.userGroups.id, schema.groupProjectGrants.groupId))
		.innerJoin(schema.projects, eq(schema.projects.id, schema.groupProjectGrants.projectId))
		.where(
			and(
				eq(schema.userGroupMembers.userId, ctx.userId),
				eq(schema.userGroups.workspaceId, ctx.workspaceId),
				eq(schema.projects.workspaceId, ctx.workspaceId)
			)
		)
		.all();
	return rows.map((r) => r.id);
}

/**
 * PROJ-785: throw ValidationError unless `userId` is a member of `ctx.workspaceId`.
 * Call this whenever a caller-supplied user id (assignee, owner, …) is about to be
 * stamped onto a workspace-scoped row, so we never persist a dangling or
 * wrong-workspace user reference. `field` names the offending input field in the
 * thrown error so REST/MCP callers can surface it against the right form field.
 */
export async function requireWorkspaceMember(
	ctx: Pick<ServiceCtx, "db" | "workspaceId">,
	userId: string,
	field = "assigneeId"
): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	const member = await orm
		.select({ userId: schema.workspaceMembers.userId })
		.from(schema.workspaceMembers)
		.where(
			and(
				eq(schema.workspaceMembers.workspaceId, ctx.workspaceId),
				eq(schema.workspaceMembers.userId, userId)
			)
		)
		.get();
	if (!member) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: { [field]: ["User is not a member of this workspace"] },
		});
	}
}

/**
 * PROJ-821: of `userIds`, the ones who can currently READ content in `projectId`
 * (`null` = workspace-level, visible to every member). Used when the caller acts on
 * behalf of OTHER users (e.g. fanning out notifications), where the per-caller guards
 * above don't apply.
 * - Not a member of ctx.workspaceId any more → excluded.
 * - Workspace owner/admin → included (admin bypass, as for the caller).
 * - Anyone else, project-scoped → included only with a group grant on that project.
 */
export async function usersWithProjectReadAccess(
	// Only db + workspaceId are read, so unauthenticated paths (public share links,
	// PROJ-794) can call this without a caller identity.
	ctx: Pick<ServiceCtx, "db" | "workspaceId">,
	projectId: string | null,
	userIds: readonly string[]
): Promise<Set<string>> {
	if (userIds.length === 0) return new Set();
	const orm = drizzle(ctx.db, { schema });
	const members = await inChunks([...userIds], (chunk) =>
		orm
			.select({ userId: schema.workspaceMembers.userId, role: schema.workspaceMembers.role })
			.from(schema.workspaceMembers)
			.where(
				and(
					eq(schema.workspaceMembers.workspaceId, ctx.workspaceId),
					inArray(schema.workspaceMembers.userId, chunk)
				)
			)
	);
	if (projectId === null) return new Set(members.map((m) => m.userId));

	const allowed = new Set(members.filter((m) => isWorkspaceAdmin(m.role)).map((m) => m.userId));
	const needGrant = members.filter((m) => !isWorkspaceAdmin(m.role)).map((m) => m.userId);
	const granted = await inChunks(needGrant, (chunk) =>
		orm
			.select({ userId: schema.userGroupMembers.userId })
			.from(schema.groupProjectGrants)
			.innerJoin(
				schema.userGroupMembers,
				eq(schema.userGroupMembers.groupId, schema.groupProjectGrants.groupId)
			)
			.where(
				and(
					eq(schema.groupProjectGrants.projectId, projectId),
					inArray(schema.userGroupMembers.userId, chunk)
				)
			)
	);
	for (const g of granted) allowed.add(g.userId);
	return allowed;
}
