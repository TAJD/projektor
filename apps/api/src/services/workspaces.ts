import { drizzle, schema } from "@projektor/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { IdSchema } from "../schemas/common";
import {
	CreateTokenSchema,
	CreateWorkspaceSchema,
	InviteMemberSchema,
	UpdateRoleSchema,
	UpdateWorkspaceSchema,
} from "../schemas/workspaces";
import { seedDefaultCustomFields } from "./custom-fields";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { seedDefaultTaskStatuses } from "./task-statuses";
import { seedDefaultTaskTypes } from "./task-types";
import type { ServiceCtx } from "./types";
import { seedDefaultWikiTemplates } from "./wiki";

async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function listWorkspaces(db: D1Database, userId: string) {
	const orm = drizzle(db, { schema });
	return orm
		.select({
			id: schema.workspaces.id,
			name: schema.workspaces.name,
			slug: schema.workspaces.slug,
			createdAt: schema.workspaces.createdAt,
			role: schema.workspaceMembers.role,
		})
		.from(schema.workspaces)
		.innerJoin(
			schema.workspaceMembers,
			eq(schema.workspaceMembers.workspaceId, schema.workspaces.id)
		)
		.where(eq(schema.workspaceMembers.userId, userId))
		.orderBy(asc(schema.workspaces.name));
}

export async function createWorkspace(db: D1Database, userId: string, input: unknown) {
	const parsed = CreateWorkspaceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { name, slug } = parsed.data;

	const orm = drizzle(db, { schema });
	const existing = await orm
		.select({ id: schema.workspaces.id })
		.from(schema.workspaces)
		.where(eq(schema.workspaces.slug, slug))
		.get();
	if (existing) throw new ConflictError("Slug already taken");

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await orm.insert(schema.workspaces).values({ id, name, slug, createdAt: now });
	await orm
		.insert(schema.workspaceMembers)
		.values({ workspaceId: id, userId, role: "owner", joinedAt: now });
	await seedDefaultTaskTypes(db, id);
	await seedDefaultTaskStatuses(db, id);
	await seedDefaultCustomFields(db, id);
	await seedDefaultWikiTemplates(db, id, userId);

	return { id, name, slug };
}

export async function getWorkspaceWithMembers(
	ctx: ServiceCtx,
	workspace: Readonly<{ id: string; name: string; slug: string }>
) {
	const orm = drizzle(ctx.db, { schema });
	const members = await orm
		.select({
			id: schema.users.id,
			email: schema.users.email,
			name: schema.users.name,
			avatarUrl: schema.users.avatarUrl,
			role: schema.workspaceMembers.role,
			joinedAt: schema.workspaceMembers.joinedAt,
		})
		.from(schema.workspaceMembers)
		.innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
		.where(eq(schema.workspaceMembers.workspaceId, ctx.workspaceId))
		.orderBy(asc(schema.workspaceMembers.joinedAt));
	return { ...workspace, members, currentUserRole: ctx.role };
}

export async function updateWorkspace(ctx: ServiceCtx, input: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const parsed = UpdateWorkspaceSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const orm = drizzle(ctx.db, { schema });
	await orm
		.update(schema.workspaces)
		.set({ name: parsed.data.name })
		.where(eq(schema.workspaces.id, ctx.workspaceId));
	return { ok: true };
}

export async function inviteMember(ctx: ServiceCtx, input: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const parsed = InviteMemberSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { email, role: newRole } = parsed.data;
	const now = Math.floor(Date.now() / 1000);

	const orm = drizzle(ctx.db, { schema });
	let user = await orm
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(eq(schema.users.email, email))
		.get();
	if (!user) {
		const newId = crypto.randomUUID();
		await orm
			.insert(schema.users)
			.values({ id: newId, email, name: email.split("@")[0], createdAt: now });
		user = { id: newId };
	}

	const existing = await orm
		.select({ workspaceId: schema.workspaceMembers.workspaceId })
		.from(schema.workspaceMembers)
		.where(
			and(
				eq(schema.workspaceMembers.workspaceId, ctx.workspaceId),
				eq(schema.workspaceMembers.userId, user.id)
			)
		)
		.get();
	if (existing) throw new ConflictError("Already a member");

	await orm
		.insert(schema.workspaceMembers)
		.values({ workspaceId: ctx.workspaceId, userId: user.id, role: newRole, joinedAt: now });
	// PROJ-436: re-inviting a previously-removed user clears their removal tombstone, so
	// provisioning can re-add them again if config (ADMIN_EMAILS etc) says it should.
	await orm
		.delete(schema.provisioningRemovals)
		.where(
			and(
				eq(schema.provisioningRemovals.workspaceId, ctx.workspaceId),
				eq(schema.provisioningRemovals.userId, user.id)
			)
		);
	return { ok: true };
}

export async function removeMember(ctx: ServiceCtx, targetUserId: string) {
	const idCheck = IdSchema.safeParse(targetUserId);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	if (ctx.role !== "owner") throw new ForbiddenError();
	if (ctx.userId === targetUserId) {
		throw new ValidationError({ formErrors: ["Cannot remove yourself as owner"], fieldErrors: {} });
	}
	const orm = drizzle(ctx.db, { schema });
	await orm
		.delete(schema.workspaceMembers)
		.where(
			and(
				eq(schema.workspaceMembers.workspaceId, ctx.workspaceId),
				eq(schema.workspaceMembers.userId, targetUserId)
			)
		);
	// PROJ-436: tombstone the removal so ensureUserProvisioned (ADMIN_EMAILS / AUTO_JOIN_ROLE /
	// WORKSPACE_DOMAIN_MAP) doesn't silently re-add this user once their provisioning cache
	// expires. Cleared by inviteMember above.
	await orm
		.insert(schema.provisioningRemovals)
		.values({
			workspaceId: ctx.workspaceId,
			userId: targetUserId,
			removedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoUpdate({
			target: [schema.provisioningRemovals.workspaceId, schema.provisioningRemovals.userId],
			set: { removedAt: Math.floor(Date.now() / 1000) },
		});
	return { ok: true };
}

export async function updateMemberRole(ctx: ServiceCtx, targetUserId: string, input: unknown) {
	if (ctx.role !== "owner") throw new ForbiddenError();
	const parsed = UpdateRoleSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const orm = drizzle(ctx.db, { schema });
	await orm
		.update(schema.workspaceMembers)
		.set({ role: parsed.data.role })
		.where(
			and(
				eq(schema.workspaceMembers.workspaceId, ctx.workspaceId),
				eq(schema.workspaceMembers.userId, targetUserId)
			)
		);
	return { ok: true };
}

export async function createToken(ctx: ServiceCtx, input: unknown) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const parsed = CreateTokenSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { name, scopes, expiresInDays } = parsed.data;

	const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
	const token =
		"pk_" +
		Array.from(tokenBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	const hash = await sha256hex(token);

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = expiresInDays ? now + expiresInDays * 86400 : null;

	const orm = drizzle(ctx.db, { schema });
	await orm.insert(schema.apiTokens).values({
		id,
		workspaceId: ctx.workspaceId,
		userId: ctx.userId,
		name,
		tokenHash: hash,
		scopes,
		expiresAt,
		createdAt: now,
	});

	return { id, token, name, scopes, expiresAt };
}

export async function listTokens(ctx: ServiceCtx) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const orm = drizzle(ctx.db, { schema });
	return orm
		.select({
			id: schema.apiTokens.id,
			name: schema.apiTokens.name,
			scopes: schema.apiTokens.scopes,
			lastUsedAt: schema.apiTokens.lastUsedAt,
			expiresAt: schema.apiTokens.expiresAt,
			createdAt: schema.apiTokens.createdAt,
		})
		.from(schema.apiTokens)
		.where(eq(schema.apiTokens.workspaceId, ctx.workspaceId))
		.orderBy(desc(schema.apiTokens.createdAt));
}

export async function revokeToken(ctx: ServiceCtx, tokenId: string) {
	if (ctx.role === "member" || ctx.role === "viewer") throw new ForbiddenError();
	const orm = drizzle(ctx.db, { schema });
	await orm
		.delete(schema.apiTokens)
		.where(
			and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.workspaceId, ctx.workspaceId))
		);
	return { ok: true };
}

export async function deleteWorkspace(
	ctx: ServiceCtx,
	pathSlug: string,
	defaultWorkspaceSlug: string
): Promise<{ ok: true }> {
	if (ctx.role !== "owner") {
		throw new ForbiddenError("Only workspace owners can delete a workspace");
	}

	const orm = drizzle(ctx.db, { schema });
	const ws = await orm
		.select({ slug: schema.workspaces.slug })
		.from(schema.workspaces)
		.where(eq(schema.workspaces.id, ctx.workspaceId))
		.get();

	if (!ws) throw new NotFoundError("Workspace not found");

	// PROJ-437: ctx.workspaceId is resolved from the X-Workspace-Slug header (or Host
	// subdomain), not the URL's :slug — without this check a caller whose header names
	// workspace A but whose URL names workspace B would silently delete A instead of B.
	if (ws.slug !== pathSlug) {
		throw new NotFoundError("Workspace not found");
	}

	if (ws.slug === defaultWorkspaceSlug) {
		throw new ValidationError({
			formErrors: ["Cannot delete the default workspace"],
			fieldErrors: {},
		});
	}

	const countRow = await orm
		.select({ n: sql<number>`count(*)` })
		.from(schema.projects)
		.where(eq(schema.projects.workspaceId, ctx.workspaceId))
		.get();

	if ((countRow?.n ?? 0) > 0) {
		throw new ConflictError("Delete all projects before deleting the workspace");
	}

	await orm.delete(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId));
	return { ok: true };
}

export async function getWorkspaceMcpInfo(
	_ctx: ServiceCtx,
	workspace: Readonly<{ id: string; slug: string }>,
	origin: string
): Promise<{
	mcpUrl: string;
	workspaceId: string;
	workspaceSlug: string;
	mcpAddCommandTemplate: string;
}> {
	const mcpUrl = `${origin}/mcp/${workspace.id}`;
	const mcpAddCommandTemplate =
		`claude mcp add projektor "${mcpUrl}" ` +
		`--transport http ` +
		`--header "Authorization: Bearer {{TOKEN}}" ` +
		`--header "X-Workspace-Slug: ${workspace.slug}"`;
	return {
		mcpUrl,
		workspaceId: workspace.id,
		workspaceSlug: workspace.slug,
		mcpAddCommandTemplate,
	};
}
