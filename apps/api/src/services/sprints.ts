import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { IdSchema } from "../schemas/common";
import {
	CreateSprintSchema,
	ListSprintsSchema,
	MoveIssuesToSprintSchema,
	UpdateSprintSchema,
} from "../schemas/sprints";
import { canWriteProject, effectiveProjectRole, isWorkspaceAdmin } from "./access";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

// PROJ-311: sprints inherit their project's visibility. Reads on an ungranted
// project 404/return empty; writes need a member/admin grant (owner/admin bypass).
async function assertSprintProjectVisible(ctx: ServiceCtx, projectId: string): Promise<void> {
	if (isWorkspaceAdmin(ctx.role)) return;
	if ((await effectiveProjectRole(ctx, projectId)) === null) {
		throw new NotFoundError("Sprint not found");
	}
}

async function requireSprintProjectWrite(ctx: ServiceCtx, projectId: string): Promise<void> {
	if (isWorkspaceAdmin(ctx.role)) return;
	const role = await effectiveProjectRole(ctx, projectId);
	if (role === null) throw new NotFoundError("Sprint not found");
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");
}

export async function listSprints(ctx: ServiceCtx, raw: unknown) {
	const result = ListSprintsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { projectId } = result.data;

	// A member without a grant on this project sees no sprints (existence hidden).
	if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
		return { items: [] };
	}

	const orm = drizzle(ctx.db, { schema });
	const items = await orm
		.select()
		.from(schema.sprints)
		.where(
			and(eq(schema.sprints.workspaceId, ctx.workspaceId), eq(schema.sprints.projectId, projectId))
		)
		.orderBy(asc(schema.sprints.createdAt));

	return { items };
}

export async function getSprint(ctx: ServiceCtx, id: string) {
	const orm = drizzle(ctx.db, { schema });
	const sprint = await orm
		.select()
		.from(schema.sprints)
		.where(and(eq(schema.sprints.id, id), eq(schema.sprints.workspaceId, ctx.workspaceId)))
		.get();

	if (!sprint) throw new NotFoundError("Sprint not found");
	await assertSprintProjectVisible(ctx, sprint.projectId);
	return sprint;
}

export async function createSprint(ctx: ServiceCtx, raw: unknown) {
	const result = CreateSprintSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { projectId, name, goal, startDate, endDate } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const project = await orm
		.select({ id: schema.projects.id })
		.from(schema.projects)
		.where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!project) throw new NotFoundError("Project not found");
	await requireSprintProjectWrite(ctx, projectId);

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await orm.insert(schema.sprints).values({
		id,
		workspaceId: ctx.workspaceId,
		projectId,
		name,
		goal: goal ?? null,
		status: "planned",
		startDate: startDate ?? null,
		endDate: endDate ?? null,
		createdAt: now,
		updatedAt: now,
	});

	return { id };
}

type SprintUpdateData = z.infer<typeof UpdateSprintSchema>;

function buildSprintSetData(data: SprintUpdateData, now: number) {
	const setData: {
		updatedAt: number;
		name?: string;
		goal?: string | null;
		status?: "planned" | "active" | "completed";
		startDate?: number | null;
		endDate?: number | null;
	} = { updatedAt: now };

	if (data.name !== undefined) setData.name = data.name;
	if ("goal" in data) setData.goal = data.goal ?? null;
	if (data.status !== undefined) setData.status = data.status;
	if ("startDate" in data) setData.startDate = data.startDate ?? null;
	if ("endDate" in data) setData.endDate = data.endDate ?? null;

	return setData;
}

export async function updateSprint(ctx: ServiceCtx, id: string, raw: unknown) {
	const result = UpdateSprintSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const data = result.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.sprints.id, projectId: schema.sprints.projectId })
		.from(schema.sprints)
		.where(and(eq(schema.sprints.id, id), eq(schema.sprints.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Sprint not found");
	await requireSprintProjectWrite(ctx, existing.projectId);

	const now = Math.floor(Date.now() / 1000);
	const setData = buildSprintSetData(data, now);

	await orm
		.update(schema.sprints)
		.set(setData)
		.where(and(eq(schema.sprints.id, id), eq(schema.sprints.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function completeSprint(ctx: ServiceCtx, id: string) {
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	const orm = drizzle(ctx.db, { schema });
	const sprint = await orm
		.select({ status: schema.sprints.status, projectId: schema.sprints.projectId })
		.from(schema.sprints)
		.where(and(eq(schema.sprints.id, id), eq(schema.sprints.workspaceId, ctx.workspaceId)))
		.get();

	if (!sprint) throw new NotFoundError("Sprint not found");
	await requireSprintProjectWrite(ctx, sprint.projectId);
	if (sprint.status !== "active") {
		throw new ValidationError({
			formErrors: ["Only active sprints can be completed"],
			fieldErrors: {},
		});
	}

	const now = Math.floor(Date.now() / 1000);
	await orm
		.update(schema.sprints)
		.set({ status: "completed", updatedAt: now })
		.where(and(eq(schema.sprints.id, id), eq(schema.sprints.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function deleteSprint(ctx: ServiceCtx, id: string) {
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({ id: schema.sprints.id, projectId: schema.sprints.projectId })
		.from(schema.sprints)
		.where(and(eq(schema.sprints.id, id), eq(schema.sprints.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Sprint not found");
	await requireSprintProjectWrite(ctx, existing.projectId);

	await orm
		.delete(schema.sprints)
		.where(and(eq(schema.sprints.id, id), eq(schema.sprints.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

export async function moveIssuesToSprint(ctx: ServiceCtx, raw: unknown) {
	const result = MoveIssuesToSprintSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueIds, sprintId } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const sprint = await orm
		.select({ id: schema.sprints.id, projectId: schema.sprints.projectId })
		.from(schema.sprints)
		.where(and(eq(schema.sprints.id, sprintId), eq(schema.sprints.workspaceId, ctx.workspaceId)))
		.get();
	if (!sprint) throw new NotFoundError("Sprint not found");
	await requireSprintProjectWrite(ctx, sprint.projectId);

	const now = Math.floor(Date.now() / 1000);
	// inChunks: issueIds is a caller-supplied batch, so keep each UPDATE under D1's
	// 100-bound-parameter cap. See services/sql.ts.
	await inChunks(issueIds, async (chunk) => {
		await orm
			.update(schema.issues)
			.set({ sprintId, updatedAt: now })
			.where(and(inArray(schema.issues.id, chunk), eq(schema.issues.workspaceId, ctx.workspaceId)));
		return [];
	});

	return { ok: true, count: issueIds.length };
}
