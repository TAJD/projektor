import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, sql } from "drizzle-orm";
import {
	AddGroupMemberSchema,
	CreateGroupSchema,
	SetGroupGrantSchema,
	UpdateGroupSchema,
} from "../schemas/groups";
import { isWorkspaceAdmin } from "./access";
import { recordActivity } from "./activity";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

function requireAdmin(ctx: ServiceCtx): void {
	if (!isWorkspaceAdmin(ctx.role)) throw new ForbiddenError();
}

/** Load a group scoped to the workspace, or throw NotFound. */
async function loadGroup(orm: ReturnType<typeof drizzle>, ctx: ServiceCtx, groupId: string) {
	const group = await orm
		.select()
		.from(schema.userGroups)
		.where(
			and(eq(schema.userGroups.id, groupId), eq(schema.userGroups.workspaceId, ctx.workspaceId))
		)
		.get();
	if (!group) throw new NotFoundError("Group not found");
	return group;
}

/**
 * List groups. Owner/admin see every group in the workspace; a plain member sees
 * only the groups they belong to (ticket: "members see only their own groups").
 */
export async function listGroups(ctx: ServiceCtx) {
	const orm = drizzle(ctx.db, { schema });
	const memberCount = sql<number>`(SELECT count(*) FROM user_group_members m
		WHERE m.group_id = ${schema.userGroups.id})`;
	const grantCount = sql<number>`(SELECT count(*) FROM group_project_grants g
		WHERE g.group_id = ${schema.userGroups.id})`;
	const cols = {
		id: schema.userGroups.id,
		name: schema.userGroups.name,
		description: schema.userGroups.description,
		createdAt: schema.userGroups.createdAt,
		memberCount,
		grantCount,
	};

	if (isWorkspaceAdmin(ctx.role)) {
		return orm
			.select(cols)
			.from(schema.userGroups)
			.where(eq(schema.userGroups.workspaceId, ctx.workspaceId))
			.orderBy(asc(schema.userGroups.name));
	}

	return orm
		.select(cols)
		.from(schema.userGroups)
		.innerJoin(schema.userGroupMembers, eq(schema.userGroupMembers.groupId, schema.userGroups.id))
		.where(
			and(
				eq(schema.userGroups.workspaceId, ctx.workspaceId),
				eq(schema.userGroupMembers.userId, ctx.userId)
			)
		)
		.orderBy(asc(schema.userGroups.name));
}

/**
 * Full group detail: members and project grants. Owner/admin may view any group;
 * a plain member may view only groups they belong to.
 */
export async function getGroup(ctx: ServiceCtx, groupId: string) {
	const orm = drizzle(ctx.db, { schema });
	const group = await loadGroup(orm, ctx, groupId);

	if (!isWorkspaceAdmin(ctx.role)) {
		const own = await orm
			.select({ userId: schema.userGroupMembers.userId })
			.from(schema.userGroupMembers)
			.where(
				and(
					eq(schema.userGroupMembers.groupId, groupId),
					eq(schema.userGroupMembers.userId, ctx.userId)
				)
			)
			.get();
		if (!own) throw new ForbiddenError();
	}

	const members = await orm
		.select({
			userId: schema.users.id,
			email: schema.users.email,
			name: schema.users.name,
			addedAt: schema.userGroupMembers.addedAt,
			addedBy: schema.userGroupMembers.addedBy,
		})
		.from(schema.userGroupMembers)
		.innerJoin(schema.users, eq(schema.users.id, schema.userGroupMembers.userId))
		.where(eq(schema.userGroupMembers.groupId, groupId))
		.orderBy(asc(schema.userGroupMembers.addedAt));

	const grants = await orm
		.select({
			projectId: schema.groupProjectGrants.projectId,
			projectName: schema.projects.name,
			projectKey: schema.projects.key,
			role: schema.groupProjectGrants.role,
		})
		.from(schema.groupProjectGrants)
		.innerJoin(schema.projects, eq(schema.projects.id, schema.groupProjectGrants.projectId))
		.where(eq(schema.groupProjectGrants.groupId, groupId))
		.orderBy(asc(schema.projects.name));

	return { ...group, members, grants };
}

/**
 * Per-member group membership for the whole workspace, driving the members-admin
 * screen (group chips + the "no groups / pending" badge). Owner/admin only.
 * Includes members with zero groups so the pending state is visible.
 */
export async function listMemberGroups(ctx: ServiceCtx) {
	requireAdmin(ctx);
	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({
			userId: schema.workspaceMembers.userId,
			groupId: schema.userGroups.id,
			groupName: schema.userGroups.name,
		})
		.from(schema.workspaceMembers)
		.leftJoin(
			schema.userGroupMembers,
			eq(schema.userGroupMembers.userId, schema.workspaceMembers.userId)
		)
		.leftJoin(
			schema.userGroups,
			and(
				eq(schema.userGroups.id, schema.userGroupMembers.groupId),
				eq(schema.userGroups.workspaceId, ctx.workspaceId)
			)
		)
		.where(eq(schema.workspaceMembers.workspaceId, ctx.workspaceId));

	const byUser = new Map<string, { id: string; name: string }[]>();
	for (const r of rows) {
		if (!byUser.has(r.userId)) byUser.set(r.userId, []);
		if (r.groupId && r.groupName) {
			byUser.get(r.userId)?.push({ id: r.groupId, name: r.groupName });
		}
	}
	return Array.from(byUser.entries()).map(([userId, groups]) => ({ userId, groups }));
}

export async function createGroup(ctx: ServiceCtx, input: unknown) {
	requireAdmin(ctx);
	const parsed = CreateGroupSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { name, description } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.userGroups.id })
		.from(schema.userGroups)
		.where(
			and(eq(schema.userGroups.workspaceId, ctx.workspaceId), eq(schema.userGroups.name, name))
		)
		.get();
	if (existing) throw new ConflictError(`Group "${name}" already exists`);

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await orm.insert(schema.userGroups).values({
		id,
		workspaceId: ctx.workspaceId,
		name,
		description: description ?? null,
		createdAt: now,
	});

	await recordActivity(ctx, {
		entityType: "group",
		entityId: id,
		action: "created",
		diff: { name },
	});
	return { id, name, description: description ?? null };
}

export async function updateGroup(ctx: ServiceCtx, groupId: string, input: unknown) {
	requireAdmin(ctx);
	const parsed = UpdateGroupSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());

	const setObj: Record<string, unknown> = {};
	if (parsed.data.name !== undefined) setObj.name = parsed.data.name;
	if (parsed.data.description !== undefined) setObj.description = parsed.data.description;
	if (Object.keys(setObj).length === 0)
		throw new ValidationError({ formErrors: ["Nothing to update"], fieldErrors: {} });

	const orm = drizzle(ctx.db, { schema });
	await loadGroup(orm, ctx, groupId);

	if (setObj.name !== undefined) {
		const clash = await orm
			.select({ id: schema.userGroups.id })
			.from(schema.userGroups)
			.where(
				and(
					eq(schema.userGroups.workspaceId, ctx.workspaceId),
					eq(schema.userGroups.name, setObj.name as string)
				)
			)
			.get();
		if (clash && clash.id !== groupId)
			throw new ConflictError(`Group "${setObj.name}" already exists`);
	}

	await orm
		.update(schema.userGroups)
		.set(setObj)
		.where(
			and(eq(schema.userGroups.id, groupId), eq(schema.userGroups.workspaceId, ctx.workspaceId))
		);

	await recordActivity(ctx, {
		entityType: "group",
		entityId: groupId,
		action: "updated",
		diff: setObj,
	});
	return { ok: true };
}

export async function deleteGroup(ctx: ServiceCtx, groupId: string) {
	requireAdmin(ctx);
	const orm = drizzle(ctx.db, { schema });
	await loadGroup(orm, ctx, groupId);

	// Members and grants cascade via the FK ON DELETE CASCADE.
	await orm
		.delete(schema.userGroups)
		.where(
			and(eq(schema.userGroups.id, groupId), eq(schema.userGroups.workspaceId, ctx.workspaceId))
		);

	await recordActivity(ctx, { entityType: "group", entityId: groupId, action: "deleted" });
	return { ok: true };
}

export async function addGroupMember(ctx: ServiceCtx, groupId: string, input: unknown) {
	requireAdmin(ctx);
	const parsed = AddGroupMemberSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { userId } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	await loadGroup(orm, ctx, groupId);

	// The target must already be a member of this workspace.
	const wsMember = await orm
		.select({ userId: schema.workspaceMembers.userId })
		.from(schema.workspaceMembers)
		.where(
			and(
				eq(schema.workspaceMembers.workspaceId, ctx.workspaceId),
				eq(schema.workspaceMembers.userId, userId)
			)
		)
		.get();
	if (!wsMember)
		throw new ValidationError({ formErrors: ["User is not a workspace member"], fieldErrors: {} });

	const now = Math.floor(Date.now() / 1000);
	await orm
		.insert(schema.userGroupMembers)
		.values({ groupId, userId, addedBy: ctx.userId, addedAt: now })
		.onConflictDoNothing();

	await recordActivity(ctx, {
		entityType: "group",
		entityId: groupId,
		action: "updated",
		diff: { addedMember: userId },
	});
	return { ok: true };
}

export async function removeGroupMember(ctx: ServiceCtx, groupId: string, userId: string) {
	requireAdmin(ctx);
	const orm = drizzle(ctx.db, { schema });
	await loadGroup(orm, ctx, groupId);

	await orm
		.delete(schema.userGroupMembers)
		.where(
			and(eq(schema.userGroupMembers.groupId, groupId), eq(schema.userGroupMembers.userId, userId))
		);

	await recordActivity(ctx, {
		entityType: "group",
		entityId: groupId,
		action: "updated",
		diff: { removedMember: userId },
	});
	return { ok: true };
}

export async function setGroupGrant(ctx: ServiceCtx, groupId: string, input: unknown) {
	requireAdmin(ctx);
	const parsed = SetGroupGrantSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { projectId, role } = parsed.data;

	const orm = drizzle(ctx.db, { schema });
	await loadGroup(orm, ctx, groupId);

	// The project must belong to this workspace.
	const project = await orm
		.select({ id: schema.projects.id })
		.from(schema.projects)
		.where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!project) throw new NotFoundError("Project not found");

	await orm
		.insert(schema.groupProjectGrants)
		.values({ groupId, projectId, role })
		.onConflictDoUpdate({
			target: [schema.groupProjectGrants.groupId, schema.groupProjectGrants.projectId],
			set: { role },
		});

	await recordActivity(ctx, {
		entityType: "group",
		entityId: groupId,
		action: "updated",
		diff: { grant: { projectId, role } },
	});
	return { ok: true };
}

export async function removeGroupGrant(ctx: ServiceCtx, groupId: string, projectId: string) {
	requireAdmin(ctx);
	const orm = drizzle(ctx.db, { schema });
	await loadGroup(orm, ctx, groupId);

	await orm
		.delete(schema.groupProjectGrants)
		.where(
			and(
				eq(schema.groupProjectGrants.groupId, groupId),
				eq(schema.groupProjectGrants.projectId, projectId)
			)
		);

	await recordActivity(ctx, {
		entityType: "group",
		entityId: groupId,
		action: "updated",
		diff: { removedGrant: projectId },
	});
	return { ok: true };
}
