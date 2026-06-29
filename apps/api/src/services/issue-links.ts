import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
	CreateIssueLinkSchema,
	DeleteIssueLinkSchema,
	ListIssueLinksSchema,
} from "../schemas/issues";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { inChunks } from "./sql";
import type { ServiceCtx } from "./types";

type StoredLinkType = "blocks" | "relates_to" | "duplicates";
type EffectiveLinkType = StoredLinkType | "blocked_by";

interface LinkRow {
	id: string;
	workspaceId: string;
	sourceIssueId: string;
	targetIssueId: string;
	type: StoredLinkType;
	createdById: string;
	createdAt: number;
}

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
	const { sourceIssueId, targetIssueId, type } = result.data;

	if (sourceIssueId === targetIssueId) {
		throw new ValidationError({ formErrors: ["An issue cannot link to itself"], fieldErrors: {} });
	}

	const canon = canonicalize(sourceIssueId, targetIssueId, type);
	const orm = drizzle(ctx.db, { schema });

	// Verify both issues exist and belong to this workspace
	const [src, tgt] = await Promise.all([
		orm
			.select({ id: schema.issues.id })
			.from(schema.issues)
			.where(
				and(eq(schema.issues.id, canon.source), eq(schema.issues.workspaceId, ctx.workspaceId))
			)
			.get(),
		orm
			.select({ id: schema.issues.id })
			.from(schema.issues)
			.where(
				and(eq(schema.issues.id, canon.target), eq(schema.issues.workspaceId, ctx.workspaceId))
			)
			.get(),
	]);
	if (!src) throw new NotFoundError("Source issue not found");
	if (!tgt) throw new NotFoundError("Target issue not found");

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
		.select({ id: schema.issueLinks.id })
		.from(schema.issueLinks)
		.where(and(eq(schema.issueLinks.id, id), eq(schema.issueLinks.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Link not found");

	await orm
		.delete(schema.issueLinks)
		.where(and(eq(schema.issueLinks.id, id), eq(schema.issueLinks.workspaceId, ctx.workspaceId)));

	return { ok: true };
}

interface LinkedIssueRow {
	id: string;
	title: string;
	number: number;
	statusCategory: string | null;
	projectKey: string | null;
}

export async function listLinksForIssue(ctx: ServiceCtx, raw: unknown) {
	const result = ListIssueLinksSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { issueId } = result.data;

	const orm = drizzle(ctx.db, { schema });

	const rows = await orm
		.select({
			id: schema.issueLinks.id,
			workspaceId: schema.issueLinks.workspaceId,
			sourceIssueId: schema.issueLinks.sourceIssueId,
			targetIssueId: schema.issueLinks.targetIssueId,
			type: schema.issueLinks.type,
			createdById: schema.issueLinks.createdById,
			createdAt: schema.issueLinks.createdAt,
		})
		.from(schema.issueLinks)
		.where(
			and(
				eq(schema.issueLinks.workspaceId, ctx.workspaceId),
				or(
					eq(schema.issueLinks.sourceIssueId, issueId),
					eq(schema.issueLinks.targetIssueId, issueId)
				)
			)
		)
		.orderBy(asc(schema.issueLinks.createdAt));

	const results = rows as LinkRow[];

	if (results.length === 0) return [];

	// Resolve effective type and linked issue id for each row
	const enriched = results.map((row) => {
		let effectiveType: EffectiveLinkType = row.type;
		let linkedIssueId: string;

		if (row.sourceIssueId === issueId) {
			linkedIssueId = row.targetIssueId;
		} else {
			linkedIssueId = row.sourceIssueId;
			if (row.type === "blocks") effectiveType = "blocked_by";
		}

		return {
			id: row.id,
			type: effectiveType,
			linkedIssueId,
			createdById: row.createdById,
			createdAt: row.createdAt,
		};
	});

	// Batch-fetch linked issue metadata (title, number, project_key, status_category)
	const linkedIds = [...new Set(enriched.map((e) => e.linkedIssueId))];
	// inChunks keeps the batch fetch under D1's 100-bound-parameter cap. See services/sql.ts.
	const issueRows = await inChunks(linkedIds, (chunk) =>
		orm
			.select({
				id: schema.issues.id,
				title: schema.issues.title,
				number: schema.issues.number,
				statusCategory: schema.issues.statusCategory,
				projectKey: schema.projects.key,
			})
			.from(schema.issues)
			.leftJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
			.where(and(inArray(schema.issues.id, chunk), eq(schema.issues.workspaceId, ctx.workspaceId)))
	);

	const issueMap = new Map((issueRows as LinkedIssueRow[]).map((r) => [r.id, r]));

	return enriched.map((e) => {
		const linked = issueMap.get(e.linkedIssueId);
		return {
			id: e.id,
			type: e.type,
			linkedIssueId: e.linkedIssueId,
			linkedIssueTitle: linked?.title ?? "",
			linkedIssueNumber: linked?.number ?? 0,
			linkedIssueProjectKey: linked?.projectKey ?? "",
			linkedIssueStatusCategory: linked?.statusCategory ?? "",
			createdById: e.createdById,
			createdAt: e.createdAt,
		};
	});
}
