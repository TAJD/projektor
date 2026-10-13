import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import {
	CreateIssueLinkSchema,
	DeleteIssueLinkSchema,
	type LinkTypeEffectiveEnum,
	type LinkTypeStoredEnum,
	ListIssueLinksSchema,
} from "../schemas/issues";
import {
	canWriteProject,
	effectiveProjectRole,
	isWorkspaceAdmin,
	visibleProjectSqlFragment,
} from "./access";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { resolveIssueIdParam } from "./issue-ref";
import type { ServiceCtx } from "./types";

// PROJ-311: linking touches two issues; a non-admin must be able to write to the
// project each issue belongs to (a missing grant reads as "issue not found").
async function requireIssueProjectWrite(
	ctx: ServiceCtx,
	projectId: string,
	notFoundLabel: string
): Promise<void> {
	if (isWorkspaceAdmin(ctx.role)) return;
	const role = await effectiveProjectRole(ctx, projectId);
	if (role === null) throw new NotFoundError(notFoundLabel);
	if (!canWriteProject(role)) throw new ForbiddenError("Insufficient permissions");
}

type StoredLinkType = z.infer<typeof LinkTypeStoredEnum>;
type EffectiveLinkType = z.infer<typeof LinkTypeEffectiveEnum>;

// Normalise the (source, target, type) triple to its canonical stored form.
// 'blocked_by' (A blocked_by B) becomes 'blocks' (B blocks A).
// 'relates_to' and 'duplicates' are symmetric: canonicalise by lexicographic order.
function canonicalize(
	source: string,
	target: string,
	inputType: string
): { source: string; target: string; type: StoredLinkType } {
	if (inputType === "blocked_by") {
		return { source: target, target: source, type: "blocks" };
	}
	const type = inputType as StoredLinkType;
	if (type === "relates_to" || type === "duplicates") {
		const [a, b] = source < target ? [source, target] : [target, source];
		return { source: a, target: b, type };
	}
	return { source, target, type };
}

export async function createLink(ctx: ServiceCtx, raw: unknown) {
	if (ctx.role === "viewer") throw new ForbiddenError("Insufficient permissions");
	const result = CreateIssueLinkSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { type } = result.data;
	const sourceIssueId = await resolveIssueIdParam(
		ctx,
		result.data.sourceIssueId,
		"Source issue not found"
	);
	const targetIssueId = await resolveIssueIdParam(
		ctx,
		result.data.targetIssueId,
		"Target issue not found"
	);

	if (sourceIssueId === targetIssueId) {
		throw new ValidationError({ formErrors: ["An issue cannot link to itself"], fieldErrors: {} });
	}

	const canon = canonicalize(sourceIssueId, targetIssueId, type);
	const orm = drizzle(ctx.db, { schema });

	// Verify both issues exist and belong to this workspace
	const [src, tgt] = await Promise.all([
		orm
			.select({ id: schema.issues.id, projectId: schema.issues.projectId })
			.from(schema.issues)
			.where(
				and(eq(schema.issues.id, canon.source), eq(schema.issues.workspaceId, ctx.workspaceId))
			)
			.get(),
		orm
			.select({ id: schema.issues.id, projectId: schema.issues.projectId })
			.from(schema.issues)
			.where(
				and(eq(schema.issues.id, canon.target), eq(schema.issues.workspaceId, ctx.workspaceId))
			)
			.get(),
	]);
	if (!src) throw new NotFoundError("Source issue not found");
	if (!tgt) throw new NotFoundError("Target issue not found");
	await requireIssueProjectWrite(ctx, src.projectId, "Source issue not found");
	await requireIssueProjectWrite(ctx, tgt.projectId, "Target issue not found");

	// Reject duplicate pairs (same source+target+type in canonical form)
	const existing = await orm
		.select({ id: schema.issueLinks.id })
		.from(schema.issueLinks)
		.where(
			and(
				eq(schema.issueLinks.workspaceId, ctx.workspaceId),
				eq(schema.issueLinks.sourceIssueId, canon.source),
				eq(schema.issueLinks.targetIssueId, canon.target),
				eq(schema.issueLinks.type, canon.type)
			)
		)
		.get();
	if (existing) throw new ConflictError("This link already exists");

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await orm.insert(schema.issueLinks).values({
		id,
		workspaceId: ctx.workspaceId,
		sourceIssueId: canon.source,
		targetIssueId: canon.target,
		type: canon.type,
		createdById: ctx.userId,
		createdAt: now,
	});

	return { id };
}

export async function deleteLink(ctx: ServiceCtx, raw: unknown) {
	if (ctx.role === "viewer") throw new ForbiddenError("Insufficient permissions");
	const result = DeleteIssueLinkSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { id } = result.data;

	const orm = drizzle(ctx.db, { schema });
	const existing = await orm
		.select({
			id: schema.issueLinks.id,
			sourceIssueId: schema.issueLinks.sourceIssueId,
			targetIssueId: schema.issueLinks.targetIssueId,
		})
		.from(schema.issueLinks)
		.where(and(eq(schema.issueLinks.id, id), eq(schema.issueLinks.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Link not found");

	if (!isWorkspaceAdmin(ctx.role)) {
		const endpoints = await orm
			.select({ id: schema.issues.id, projectId: schema.issues.projectId })
			.from(schema.issues)
			.where(
				and(
					eq(schema.issues.workspaceId, ctx.workspaceId),
					inArray(schema.issues.id, [existing.sourceIssueId, existing.targetIssueId])
				)
			);
		for (const ep of endpoints) {
			await requireIssueProjectWrite(ctx, ep.projectId, "Link not found");
		}
	}

	await orm
		.delete(schema.issueLinks)
		.where(and(eq(schema.issueLinks.id, id), eq(schema.issueLinks.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

// PROJ-1018: one statement returns every link of an issue together with the other end's
// metadata, so getIssue can fold it into its single D1 batch. The other end is joined
// on workspace and, for non-admins, on project visibility (PROJ-1026): a link whose
// other end the caller can't see is dropped, in either orientation.
type LinkJoinRow = {
	id: string;
	source_issue_id: string;
	target_issue_id: string;
	type: StoredLinkType;
	created_by_id: string;
	created_at: number;
	linked_id: string | null;
	linked_title: string | null;
	linked_number: number | null;
	linked_status_category: string | null;
	linked_project_key: string | null;
};

export function buildLinksForIssueStatement(ctx: ServiceCtx, issueId: string): D1PreparedStatement {
	const visible = visibleProjectSqlFragment(ctx, "li.project_id");
	return ctx.db
		.prepare(
			`SELECT l.id, l.source_issue_id, l.target_issue_id, l.type, l.created_by_id, l.created_at,
				li.id AS linked_id, li.title AS linked_title, li.number AS linked_number,
				li.status_category AS linked_status_category, p.key AS linked_project_key
			FROM issue_links l
			LEFT JOIN issues li ON li.workspace_id = ?
				AND li.id = CASE WHEN l.source_issue_id = ? THEN l.target_issue_id ELSE l.source_issue_id END
			LEFT JOIN projects p ON p.id = li.project_id
			WHERE l.workspace_id = ? AND (l.source_issue_id = ? OR l.target_issue_id = ?)
			${visible ? `AND li.id IS NOT NULL AND ${visible.sql}` : ""}
			ORDER BY l.created_at ASC`
		)
		.bind(ctx.workspaceId, issueId, ctx.workspaceId, issueId, issueId, ...(visible?.params ?? []));
}

export function mapLinksForIssue(issueId: string, rows: ReadonlyArray<LinkJoinRow>) {
	return rows.map((row) => {
		let type: EffectiveLinkType = row.type;
		let linkedIssueId: string;
		if (row.source_issue_id === issueId) {
			linkedIssueId = row.target_issue_id;
		} else {
			linkedIssueId = row.source_issue_id;
			if (row.type === "blocks") type = "blocked_by";
			else if (row.type === "follows_from") type = "followed_by";
		}
		return {
			id: row.id,
			type,
			linkedIssueId,
			linkedIssueTitle: row.linked_title ?? "",
			linkedIssueNumber: row.linked_number ?? 0,
			linkedIssueProjectKey: row.linked_project_key ?? "",
			linkedIssueStatusCategory: row.linked_status_category ?? "",
			createdById: row.created_by_id,
			createdAt: row.created_at,
		};
	});
}

export async function listLinksForIssue(ctx: ServiceCtx, raw: unknown) {
	const result = ListIssueLinksSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const issueId = await resolveIssueIdParam(ctx, result.data.issueId);

	// PROJ-311: don't leak links for an issue in a project the user can't see.
	if (!isWorkspaceAdmin(ctx.role)) {
		const orm = drizzle(ctx.db, { schema });
		const issue = await orm
			.select({ projectId: schema.issues.projectId })
			.from(schema.issues)
			.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, ctx.workspaceId)))
			.get();
		if (!issue || (await effectiveProjectRole(ctx, issue.projectId)) === null) {
			throw new NotFoundError("Issue not found");
		}
	}

	const { results } = await buildLinksForIssueStatement(ctx, issueId).all<LinkJoinRow>();
	return mapLinksForIssue(issueId, results);
}
