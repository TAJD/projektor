import { drizzle, schema } from "@projektor/db";
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { issuePath } from "../lib/urls";
import { AddCommentSchema } from "../schemas/comments";
import { BooleanQueryParam, IdSchema } from "../schemas/common";
import {
	CreateIssueSchema,
	GetIssueSchema,
	GetIssuesBatchSchema,
	ListIssuesSchema,
	SearchIssuesInputSchema,
	UpdateIssueSchema,
} from "../schemas/issues";
import {
	canWriteProject,
	effectiveProjectRole,
	isWorkspaceAdmin,
	requireProjectInWorkspace,
	requireWorkspaceMember,
	visibleProjectPredicate,
	visibleProjectSqlFragment,
} from "./access";
import { recordActivity } from "./activity";
import * as cache from "./cache";
import { buildAddCommentInsertStatement } from "./comments";
import {
	batchLoadCustomFields,
	buildCustomFieldUpsertStatements,
	validateCustomFields,
} from "./custom-fields";
import { dorColumns } from "./definition-of-ready";
import { ForbiddenError, flattenWithPaths, NotFoundError, ValidationError } from "./errors";
import { isExternallyVerifiableEvidence } from "./evidence-classification";
import { buildReleaseClaimsForClosedIssueStatement } from "./file-claims";
import {
	buildReleaseLeaseForClosedIssueStatement,
	buildTouchAgentHeartbeatIfLiveStatement,
	isLiveAgentSessionId,
	issueEverHadAgentLease,
	issueHasLiveAgentLease,
	SESSION_TTL_SECONDS,
} from "./issue-leases";
import { createLink, listLinksForIssue } from "./issue-links";
import { ISSUE_REF_PATTERN, resolveIssueIdParam, resolveVisibleIssueIdParam } from "./issue-ref";
import { resolveProjectIdParam, resolveVisibleProjectIdParam } from "./projects";
import { broadcastWorkspaceEvent } from "./realtime";
import { inChunks, sanitizeFtsQuery } from "./sql";
import { resolveStatus } from "./task-statuses";
import type { ServiceCtx } from "./types";

const ISSUE_TTL = 300;

// PROJ-870: turns a drizzle-built query into a D1PreparedStatement without executing it, so
// it can be folded into a caller's own ctx.db.batch() array — same pattern as
// services/wiki.ts and services/file-claims.ts.
function toD1Statement(
	ctx: ServiceCtx,
	query: Readonly<{ sql: string; params: unknown[] }>
): D1PreparedStatement {
	return ctx.db.prepare(query.sql).bind(...query.params);
}

// biome-ignore lint/suspicious/noExplicitAny: Drizzle SQL condition array; typed condition union is unwieldy
type Condition = any;

// Validates a candidate parentId: checks workspace scope, cycle prevention, and depth cap (max 5).
// Pass issueId=null on create (no cycle possible yet); pass the existing issue's id on update.
async function validateParent(
	ctx: ServiceCtx,
	parentId: string,
	issueId: string | null
): Promise<void> {
	if (issueId && parentId === issueId) {
		throw new ValidationError({
			formErrors: ["An issue cannot be its own parent"],
			fieldErrors: {},
		});
	}

	// PROJ-870: one recursive CTE replaces the parent SELECT plus one SELECT per ancestor
	// level. Row depth 0 is the parent itself (existence + project for the visibility
	// check); depths 1..5 are its ancestors, nearest first, every step workspace-scoped.
	// `depth < 5` stops the recursion at the 5th ancestor — the most the checks below can
	// ever look at, and a hard bound should the stored tree ever contain a cycle.
	const { results: chain } = await ctx.db
		.prepare(
			`WITH RECURSIVE chain(id, parent_id, project_id, depth) AS (
				SELECT id, parent_id, project_id, 0 FROM issues WHERE id = ? AND workspace_id = ?
				UNION ALL
				SELECT i.id, i.parent_id, i.project_id, c.depth + 1
				FROM issues i
				JOIN chain c ON i.id = c.parent_id
				WHERE i.workspace_id = ? AND c.depth < 5
			)
			SELECT id, project_id, depth FROM chain ORDER BY depth ASC`
		)
		.bind(parentId, ctx.workspaceId, ctx.workspaceId)
		.all<{ id: string; project_id: string; depth: number }>();

	const parentRow = chain[0];
	if (!parentRow) throw new NotFoundError("Parent issue not found");
	if (
		!isWorkspaceAdmin(ctx.role) &&
		(await effectiveProjectRole(ctx, parentRow.project_id)) === null
	) {
		throw new NotFoundError("Parent issue not found");
	}

	// Same checks, in the same order, as the old per-level loop: for each ancestor of the
	// parent (nearest first) test for a cycle, then count it and test the cap. So when the
	// issue itself is the 5th ancestor, the cycle error still wins over the depth error.
	// If the parent already has 5 ancestors, the child would be at depth 6 — exceeds the cap.
	let ancestorCount = 0;
	for (const { id: ancestorId } of chain.slice(1)) {
		if (issueId && ancestorId === issueId) {
			throw new ValidationError({
				formErrors: ["Setting this parent would create a cycle"],
				fieldErrors: {},
			});
		}

		ancestorCount++;
		if (ancestorCount >= 5) {
			throw new ValidationError({
				formErrors: ["Maximum nesting depth (5) exceeded"],
				fieldErrors: {},
			});
		}
	}
}

type ListIssuesFilters = z.infer<typeof ListIssuesSchema>;

// PROJ-960: `issues.labels` is a JSON array string. json_each() raises on malformed JSON,
// which would turn one bad row into a 500 for the whole list, so a non-JSON value reads as
// an empty label set instead (the column is only ever written via JSON.stringify, so this
// is insurance, not an expected path). Labels match exactly — they're tags, not text.
const labelsJsonSql = (col: string) =>
	`CASE WHEN json_valid(${col}) THEN CASE WHEN json_type(${col}) = 'array' THEN ${col} ELSE '[]' END ELSE '[]' END` as const;

// Mirrors the per-label cap in schemas/issues.ts (z.string().max(50)).
const MAX_LABEL_LENGTH = 50;

type LabelFilter = Readonly<{ labels?: string[]; labelsMode?: "all" | "any" }>;

/**
 * Raw-SQL form of the label filter, for the hand-written FTS query in searchIssues. `col`
 * is the (already table-qualified) labels column. All-of means one EXISTS per label, so
 * every label must be present; "any" is a single EXISTS over an IN list. At most 20 labels
 * (schema cap), well under D1's 100-parameter limit.
 */
function labelFilterSql(col: string, filter: LabelFilter): { sql: string; params: string[] } {
	const labels = [...new Set(filter.labels ?? [])];
	if (labels.length === 0) return { sql: "", params: [] };
	const json = labelsJsonSql(col);
	if (filter.labelsMode === "any") {
		return {
			sql: ` AND EXISTS (SELECT 1 FROM json_each(${json}) WHERE value IN (${labels.map(() => "?").join(", ")}))`,
			params: labels,
		};
	}
	return {
		sql: labels
			.map(() => ` AND EXISTS (SELECT 1 FROM json_each(${json}) WHERE value = ?)`)
			.join(""),
		params: labels,
	};
}

function addLabelFilter(conditions: Condition[], filters: LabelFilter): void {
	const labels = [...new Set(filters.labels ?? [])];
	if (labels.length === 0) return;
	const json = sql.raw(labelsJsonSql('"issues"."labels"'));
	if (filters.labelsMode === "any") {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM json_each(${json}) WHERE value IN (${sql.join(
				labels.map((l) => sql`${l}`),
				sql`, `
			)}))`
		);
		return;
	}
	for (const label of labels) {
		conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${json}) WHERE value = ${label})`);
	}
}

const MAX_STATUS_IDS_FILTER = 50;

function addStatusFilters(conditions: Condition[], filters: ListIssuesFilters): void {
	const { status, statusId, statusIds, category, priority, priorities } = filters;

	if (status)
		conditions.push(
			eq(
				schema.issues.status,
				status as "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled"
			)
		);
	if (statusId) conditions.push(eq(schema.issues.statusId, statusId));
	if (statusIds) {
		const ids = statusIds
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (ids.length > MAX_STATUS_IDS_FILTER) {
			throw new ValidationError({
				formErrors: [`statusIds accepts at most ${MAX_STATUS_IDS_FILTER} ids`],
				fieldErrors: {},
			});
		}
		if (ids.length) conditions.push(inArray(schema.issues.statusId, ids));
	}
	if (category) conditions.push(eq(schema.issues.statusCategory, category));
	if (filters.open) {
		if (category) {
			throw new ValidationError({
				formErrors: [],
				fieldErrors: { open: ["open cannot be combined with category"] },
			});
		}
		conditions.push(
			notInArray(schema.issues.status, ["done", "cancelled"]),
			or(
				isNull(schema.issues.statusCategory),
				notInArray(schema.issues.statusCategory, ["done", "cancelled"])
			)
		);
	}
	if (filters.needsAudit !== undefined) {
		conditions.push(eq(schema.issues.needsAudit, filters.needsAudit));
	}
	if (priority)
		conditions.push(
			eq(schema.issues.priority, priority as "urgent" | "high" | "medium" | "low" | "none")
		);
	if (priorities) {
		const vals = priorities
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean) as ("urgent" | "high" | "medium" | "low" | "none")[];
		if (vals.length) conditions.push(inArray(schema.issues.priority, vals));
	}
}

function addAssociationFilters(
	conditions: Condition[],
	ctx: ServiceCtx,
	filters: ListIssuesFilters
): void {
	const { projectId, assignee, parentId, noParent, typeId, excludeTypeIds, sprintId } = filters;

	if (projectId) conditions.push(eq(schema.issues.projectId, projectId));
	// PROJ-444: "me" resolves to the calling user, so a caller never needs its own id.
	if (assignee)
		conditions.push(eq(schema.issues.assigneeId, assignee === "me" ? ctx.userId : assignee));
	if (parentId) conditions.push(eq(schema.issues.parentId, parentId));
	if (noParent) conditions.push(isNull(schema.issues.parentId));
	if (typeId) conditions.push(eq(schema.issues.typeId, typeId));
	if (excludeTypeIds) {
		const ids = excludeTypeIds
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		// Exclude issues of these types (e.g. epics). Type ids come from workspace config, so the
		// array is bounded — no D1 chunking needed. Keep untyped issues (NULL type_id): SQL
		// `type_id NOT IN (...)` is NULL for a NULL type_id, which would otherwise drop them.
		if (ids.length)
			conditions.push(or(isNull(schema.issues.typeId), notInArray(schema.issues.typeId, ids)));
	}
	if (sprintId) conditions.push(eq(schema.issues.sprintId, sprintId));
}

async function addCustomFieldFilter(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	conditions: Condition[],
	filters: ListIssuesFilters
): Promise<void> {
	const { cfKey, cfOp, cfValue } = filters;
	if (!cfKey) return;

	const fieldDef = await orm
		.select({ id: schema.customFieldDefinitions.id, type: schema.customFieldDefinitions.type })
		.from(schema.customFieldDefinitions)
		.where(
			and(
				eq(schema.customFieldDefinitions.workspaceId, ctx.workspaceId),
				eq(schema.customFieldDefinitions.key, cfKey)
			)
		)
		.get();
	if (!fieldDef)
		throw new ValidationError({
			formErrors: [`Unknown custom field key: ${cfKey}`],
			fieldErrors: {},
		});

	const op = cfOp ?? "eq";
	if (op === "eq") {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM custom_field_values
				WHERE issue_id = ${schema.issues.id} AND field_id = ${fieldDef.id}
				AND value = ${cfValue ?? ""})`
		);
	} else {
		const sqlOp = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op] ?? ">";
		conditions.push(
			sql`EXISTS (SELECT 1 FROM custom_field_values
				WHERE issue_id = ${schema.issues.id} AND field_id = ${fieldDef.id}
				AND CAST(value AS REAL) ${sql.raw(sqlOp)} ${parseFloat(cfValue ?? "0")})`
		);
	}
}

// Date-range filters (PROJ-212) — inclusive bounds, index-backed.
function addDateRangeFilters(conditions: Condition[], filters: ListIssuesFilters): void {
	const { completedAfter, completedBefore, updatedAfter, updatedBefore } = filters;

	if (completedAfter) conditions.push(gte(schema.issues.completedAt, completedAfter));
	if (completedBefore) conditions.push(lte(schema.issues.completedAt, completedBefore));
	if (updatedAfter) conditions.push(gte(schema.issues.updatedAt, updatedAfter));
	if (updatedBefore) conditions.push(lte(schema.issues.updatedAt, updatedBefore));
}

async function buildListIssuesConditions(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	filters: ListIssuesFilters
): Promise<Condition[]> {
	const conditions: Condition[] = [eq(schema.issues.workspaceId, ctx.workspaceId)];
	// PROJ-311: default-deny — a non-admin only sees issues in projects their groups grant.
	const visible = visibleProjectPredicate(ctx, schema.issues.projectId);
	if (visible) conditions.push(visible);
	addStatusFilters(conditions, filters);
	addAssociationFilters(conditions, ctx, filters);
	addLabelFilter(conditions, filters);
	await addCustomFieldFilter(orm, ctx, conditions, filters);
	addDateRangeFilters(conditions, filters);
	return conditions;
}

export async function listIssues(ctx: ServiceCtx, raw: unknown) {
	const result = ListIssuesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const filters = {
		...result.data,
		projectId: result.data.projectId
			? await resolveVisibleProjectIdParam(ctx, result.data.projectId)
			: result.data.projectId,
		parentId: result.data.parentId
			? await resolveVisibleIssueIdParam(ctx, result.data.parentId)
			: result.data.parentId,
	};
	const { limit } = filters;

	const orm = drizzle(ctx.db, { schema });

	// Conditions exclude the pagination cursor, so they represent the full filtered set —
	// used as-is for the total count, and extended with the cursor below for the page query.
	const conditions = await buildListIssuesConditions(orm, ctx, filters);
	const cursor = filters.cursor;
	const pageConditions = !cursor
		? conditions
		: cursor.id === undefined
			? [...conditions, sql`${schema.issues.createdAt} < ${cursor.createdAt}`]
			: [
					...conditions,
					sql`(${schema.issues.createdAt} < ${cursor.createdAt} OR (${schema.issues.createdAt} = ${cursor.createdAt} AND ${schema.issues.id} < ${cursor.id}))`,
				];

	// PROJ-857: the filtered total only changes the header count, which the first page
	// already set — later pages skip the COUNT(*) and return total: null.
	const total = cursor ? null : await orm.$count(schema.issues, and(...conditions));

	// Select with snake_case aliases to preserve the same response shape as the raw-SQL version.
	// labels uses a raw SQL expression to return the stored JSON string (bypassing Drizzle's
	// mode:'json' deserializer), matching what callers expect.
	const rows = await orm
		.select({
			id: schema.issues.id,
			workspace_id: schema.issues.workspaceId,
			project_id: schema.issues.projectId,
			number: schema.issues.number,
			title: schema.issues.title,
			body: schema.issues.body,
			status: schema.issues.status,
			priority: schema.issues.priority,
			assignee_id: schema.issues.assigneeId,
			labels: sql<string>`${schema.issues.labels}`,
			parent_id: schema.issues.parentId,
			parent_ref: parentRefColumn(ctx),
			type_id: schema.issues.typeId,
			status_id: schema.issues.statusId,
			status_category: schema.taskStatuses.category,
			sprint_id: schema.issues.sprintId,
			created_by_id: schema.issues.createdById,
			author_kind: schema.issues.authorKind,
			created_at: schema.issues.createdAt,
			updated_at: schema.issues.updatedAt,
			completed_at: schema.issues.completedAt,
			needs_audit: schema.issues.needsAudit,
			assignee_name: schema.users.name,
			project_key: schema.projects.key,
			project_name: schema.projects.name,
			type_key: schema.taskTypes.key,
			type_name: schema.taskTypes.name,
			status_key: schema.taskStatuses.key,
			status_name: schema.taskStatuses.name,
		})
		.from(schema.issues)
		.leftJoin(schema.users, eq(schema.issues.assigneeId, schema.users.id))
		.leftJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.leftJoin(schema.taskTypes, eq(schema.issues.typeId, schema.taskTypes.id))
		.leftJoin(schema.taskStatuses, eq(schema.issues.statusId, schema.taskStatuses.id))
		.where(and(...pageConditions))
		.orderBy(desc(schema.issues.createdAt), desc(schema.issues.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const lastItem = items[items.length - 1] as { created_at: number; id: string } | undefined;
	const nextCursor = hasMore && lastItem ? `${lastItem.created_at}:${lastItem.id}` : null;

	const issueIds = (items as Array<{ id: string }>).map((i) => i.id);
	const customFieldsByIssue = await batchLoadCustomFields(ctx.db, ctx.workspaceId, issueIds);
	// PROJ-441: computed in one grouped query for the whole page, rather than the
	// frontend fanning out a getIssue call per row.
	const rollupsByParent = filters.includeRollups
		? await computeChildRollupsForParents(ctx, orm, issueIds)
		: null;

	const itemsWithFields = (items as Array<Record<string, unknown>>).map((i) => {
		// PROJ-442: body is omitted by default — callers that need it pass includeBody=1.
		const { body: _body, ...rest } = i;
		const item: Record<string, unknown> = {
			...rest,
			...(filters.includeBody ? { body: i.body } : {}),
			customFields: customFieldsByIssue[i.id as string] ?? [],
			url: i.project_key
				? issuePath(i.project_key as string, i.number as number, i.title as string)
				: null,
		};
		if (rollupsByParent) item.rollup = rollupsByParent[i.id as string] ?? computeChildRollup([]);
		return item;
	});

	return { items: itemsWithFields, nextCursor, total };
}

// PROJ-441: batched sibling of the single-issue rollup in getIssue below — one grouped
// query for every parent id on the page instead of N getIssue-shaped queries. Groups by
// the raw `status` column, exactly like getIssue's child query, so the two surfaces
// return identical rollups for the same parent — byStatus keys and the done/remaining
// derivation in computeChildRollup must never diverge between them. Workspace-scoped
// like every query; deliberately NOT project-visibility filtered, matching getIssue's
// own child rollup (see assertIssueProjectVisible — that gate applies to the parent
// issue, not to counting its children).
async function computeChildRollupsForParents(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	parentIds: string[]
): Promise<Record<string, ReturnType<typeof computeChildRollup>>> {
	if (parentIds.length === 0) return {};

	type ChildRow = { parent_id: string; status: string; count: number };
	const rows = (await inChunks(parentIds, (chunk) =>
		orm
			.select({
				parent_id: schema.issues.parentId,
				status: schema.issues.status,
				count: sql<number>`count(*)`,
			})
			.from(schema.issues)
			.where(
				and(eq(schema.issues.workspaceId, ctx.workspaceId), inArray(schema.issues.parentId, chunk))
			)
			.groupBy(schema.issues.parentId, schema.issues.status)
	)) as ChildRow[];

	const rowsByParent: Record<string, Array<{ status: string; count: number }>> = {};
	for (const row of rows) {
		if (!rowsByParent[row.parent_id]) rowsByParent[row.parent_id] = [];
		rowsByParent[row.parent_id].push({ status: row.status, count: row.count });
	}

	const result: Record<string, ReturnType<typeof computeChildRollup>> = {};
	for (const parentId of parentIds) {
		result[parentId] = computeChildRollup(rowsByParent[parentId] ?? []);
	}
	return result;
}

// Snake-case aliases preserve the existing response contract. The labels raw expression
// bypasses mode:'json' deserialization so callers receive the stored JSON string as before.
function parentRefColumn(ctx: ServiceCtx) {
	const visible = visibleProjectPredicate(ctx, sql.raw("pi.project_id"));
	return sql<string | null>`(SELECT pp.key || '-' || pi.number FROM issues pi
		JOIN projects pp ON pp.id = pi.project_id
		WHERE pi.id = ${schema.issues.parentId} AND pi.workspace_id = ${ctx.workspaceId}
		${visible ? sql`AND ${visible}` : sql``})`;
}

const issueColumns = (ctx: ServiceCtx) => ({
	parent_ref: parentRefColumn(ctx),
	id: schema.issues.id,
	workspace_id: schema.issues.workspaceId,
	project_id: schema.issues.projectId,
	number: schema.issues.number,
	title: schema.issues.title,
	body: schema.issues.body,
	status: schema.issues.status,
	priority: schema.issues.priority,
	assignee_id: schema.issues.assigneeId,
	labels: sql<string>`${schema.issues.labels}`,
	parent_id: schema.issues.parentId,
	type_id: schema.issues.typeId,
	status_id: schema.issues.statusId,
	status_category: schema.taskStatuses.category,
	sprint_id: schema.issues.sprintId,
	created_by_id: schema.issues.createdById,
	author_kind: schema.issues.authorKind,
	created_at: schema.issues.createdAt,
	updated_at: schema.issues.updatedAt,
	completed_at: schema.issues.completedAt,
	needs_audit: schema.issues.needsAudit,
	project_key: schema.projects.key,
	project_name: schema.projects.name,
	type_key: schema.taskTypes.key,
	type_name: schema.taskTypes.name,
	status_key: schema.taskStatuses.key,
	status_name: schema.taskStatuses.name,
});

async function fetchIssueById(orm: ReturnType<typeof drizzle>, ctx: ServiceCtx, id: string) {
	return (
		(await orm
			.select(issueColumns(ctx))
			.from(schema.issues)
			.leftJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
			.leftJoin(schema.taskTypes, eq(schema.issues.typeId, schema.taskTypes.id))
			.leftJoin(schema.taskStatuses, eq(schema.issues.statusId, schema.taskStatuses.id))
			.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
			.get()) ?? null
	);
}

// PROJ-959: the ref pattern and resolver moved to services/issue-ref.ts so services that
// issues.ts itself imports (comments, leases, file claims) can resolve refs without an
// import cycle. Re-exported here so existing callers keep their import path.
export { ISSUE_REF_PATTERN, resolveIssueIdParam };

async function fetchIssueByRef(orm: ReturnType<typeof drizzle>, ctx: ServiceCtx, ref: string) {
	const m = ref.match(ISSUE_REF_PATTERN);
	if (!m)
		throw new ValidationError({
			formErrors: ["ref must be in format KEY-NUMBER"],
			fieldErrors: {},
		});
	return (
		(await orm
			.select(issueColumns(ctx))
			.from(schema.issues)
			.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
			.leftJoin(schema.taskTypes, eq(schema.issues.typeId, schema.taskTypes.id))
			.leftJoin(schema.taskStatuses, eq(schema.issues.statusId, schema.taskStatuses.id))
			.where(
				and(
					eq(schema.projects.key, m[1]),
					eq(schema.issues.number, parseInt(m[2], 10)),
					eq(schema.issues.workspaceId, ctx.workspaceId)
				)
			)
			.get()) ?? null
	);
}

function computeChildRollup(childRows: ReadonlyArray<{ status: string; count: number }>) {
	const byStatus: Record<string, number> = {};
	let total = 0;
	for (const r of childRows) {
		byStatus[r.status] = r.count;
		total += r.count;
	}
	const done = (byStatus.done ?? 0) + (byStatus.cancelled ?? 0);
	const remaining = total - done;
	return { total, byStatus, done, remaining };
}

// PROJ-311: an issue is only visible if its project is granted to one of the
// user's groups (owner/admin bypass). Throw the issue-not-found error rather than a
// project one so an invisible issue's existence never leaks.
async function assertIssueProjectVisible(ctx: ServiceCtx, projectId: string): Promise<void> {
	if (isWorkspaceAdmin(ctx.role)) return;
	if ((await effectiveProjectRole(ctx, projectId)) === null) {
		throw new NotFoundError("Issue not found");
	}
}

async function fetchIssueByIdOrRef(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	id: string | undefined,
	ref: string | undefined
) {
	if (id) {
		return ISSUE_REF_PATTERN.test(id)
			? fetchIssueByRef(orm, ctx, id)
			: fetchIssueById(orm, ctx, id);
	}
	if (ref) return fetchIssueByRef(orm, ctx, ref);
	return null;
}

function buildIssueUrl(issueRecord: Record<string, unknown>): string | null {
	return issueRecord.project_key
		? issuePath(
				issueRecord.project_key as string,
				issueRecord.number as number,
				issueRecord.title as string
			)
		: null;
}

// PROJ-863: what the KV cache holds for an issue — only data owned by the issue itself
// and invalidated by its own writes (child rollup via the parent invalidation, custom
// field values via the issue update). Everything that embeds OTHER entities — linked
// issues' titles/statuses, status/type names, project key, sprint — is read live on
// every request (the row fetch is one joined query, links one more), so renaming or
// deleting those can never leave a stale copy behind. Entries written in the old
// full-payload shape still carry these two keys, so they stay readable.
type CachedIssueExtras = { rollup: ReturnType<typeof computeChildRollup>; customFields: unknown[] };

async function loadIssueExtras(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	issueId: string
): Promise<CachedIssueExtras> {
	const key = `issue:${ctx.workspaceId}:${issueId}`;
	const cached = await cache.get<CachedIssueExtras>(ctx.kv, key);
	if (cached?.rollup && cached.customFields) {
		return { rollup: cached.rollup, customFields: cached.customFields };
	}

	type ChildCount = { status: string; count: number };
	const childRows = (await orm.all(
		sql`SELECT status, COUNT(*) as count FROM issues
			WHERE parent_id = ${issueId} AND workspace_id = ${ctx.workspaceId}
			GROUP BY status`
	)) as ChildCount[];
	const customFieldsByIssue = await batchLoadCustomFields(ctx.db, ctx.workspaceId, [issueId]);
	const extras: CachedIssueExtras = {
		rollup: computeChildRollup(childRows),
		customFields: customFieldsByIssue[issueId] ?? [],
	};
	await cache.set(ctx.kv, key, extras, ISSUE_TTL);
	return extras;
}

export async function getIssue(ctx: ServiceCtx, raw: unknown) {
	const result = GetIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { id, ref } = result.data;

	const orm = drizzle(ctx.db, { schema });

	const issue = await fetchIssueByIdOrRef(orm, ctx, id, ref);
	if (!issue) throw new NotFoundError("Issue not found");

	const issueRecord = issue as Record<string, unknown>;
	await assertIssueProjectVisible(ctx, issueRecord.project_id as string);
	const issueId = issueRecord.id as string;

	const { rollup, customFields } = await loadIssueExtras(ctx, orm, issueId);
	const links = await listLinksForIssue(ctx, { issueId });

	const full: Record<string, unknown> = {
		...issueRecord,
		rollup,
		links,
		customFields,
		url: buildIssueUrl(issueRecord),
	};
	return full;
}

// PROJ-931: fetch up to 50 issues in one call, by ref (KEY-NUMBER) and/or id, for agents
// triaging many issues at once. Refs are resolved to ids first — one query per distinct
// project key (batching the numbers for that key via inChunks) since a tuple IN
// (project_id, number) isn't expressible through drizzle's inArray. The resolved ids are
// then merged with any explicit ids and fetched in one inChunks-batched query, scoped by
// workspace and project visibility like every other issue read. Shape matches listIssues'
// items (customFields, no rollup/links) rather than getIssue's full shape, since loading
// rollup/links per issue here would be an N+1 the batch is meant to avoid.
export async function getIssuesBatch(ctx: ServiceCtx, raw: unknown) {
	const result = GetIssuesBatchSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { refs = [], ids = [], includeBody } = result.data;

	const orm = drizzle(ctx.db, { schema });

	// PROJ-931 review: preserve the caller's request order (refs first, then ids, exactly
	// as given) and remember which literal string ("PROJ-42" or a raw id) each resolved id
	// came from, so an id that fails the visibility check below can still be reported back
	// under the identifier the caller actually used.
	const order: Array<{ requested: string; id: string | undefined }> = [];

	const refLike = [...refs, ...ids.filter((id) => ISSUE_REF_PATTERN.test(id))];
	const numbersByKey = new Map<string, number[]>();
	for (const ref of refLike) {
		const m = ref.match(ISSUE_REF_PATTERN);
		if (!m)
			throw new ValidationError({
				formErrors: [`Invalid ref: ${ref} (expected KEY-NUMBER)`],
				fieldErrors: {},
			});
		const nums = numbersByKey.get(m[1]) ?? [];
		nums.push(parseInt(m[2], 10));
		numbersByKey.set(m[1], nums);
	}
	// Canonical lookup key for a ref, so a zero-padded "PROJ-042" matches the resolved
	// "PROJ-42" the same way single get_issue does.
	const canonicalRef = (ref: string) => {
		const m = ref.match(ISSUE_REF_PATTERN) as RegExpMatchArray;
		return `${m[1]}-${parseInt(m[2], 10)}`;
	};

	// ref -> resolved id, filled in per project key below.
	const refToId = new Map<string, string>();
	for (const [key, numbers] of numbersByKey) {
		const rows = await inChunks(numbers, (chunk) =>
			orm
				.select({ id: schema.issues.id, number: schema.issues.number })
				.from(schema.issues)
				.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
				.where(
					and(
						eq(schema.projects.key, key),
						eq(schema.issues.workspaceId, ctx.workspaceId),
						inArray(schema.issues.number, chunk)
					)
				)
		);
		for (const row of rows) refToId.set(`${key}-${row.number}`, row.id);
	}
	for (const ref of refs) order.push({ requested: ref, id: refToId.get(canonicalRef(ref)) });
	for (const id of ids) {
		order.push({
			requested: id,
			id: ISSUE_REF_PATTERN.test(id) ? refToId.get(canonicalRef(id)) : id,
		});
	}

	const allIds = Array.from(new Set(order.map((o) => o.id).filter((id): id is string => !!id)));

	let rowsById = new Map<string, Record<string, unknown>>();
	if (allIds.length > 0) {
		const visible = visibleProjectPredicate(ctx, schema.issues.projectId);
		const rows = await inChunks(allIds, (chunk) => {
			const conditions = [
				inArray(schema.issues.id, chunk),
				eq(schema.issues.workspaceId, ctx.workspaceId),
			];
			if (visible) conditions.push(visible);
			return orm
				.select(issueColumns(ctx))
				.from(schema.issues)
				.leftJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
				.leftJoin(schema.taskTypes, eq(schema.issues.typeId, schema.taskTypes.id))
				.leftJoin(schema.taskStatuses, eq(schema.issues.statusId, schema.taskStatuses.id))
				.where(and(...conditions));
		});

		const issueIds = (rows as Array<{ id: string }>).map((r) => r.id);
		const customFieldsByIssue = await batchLoadCustomFields(ctx.db, ctx.workspaceId, issueIds);
		rowsById = new Map(
			(rows as Array<Record<string, unknown>>).map((r) => {
				// Match list_issues: body only on request (PROJ-442) — 50 full bodies would
				// defeat the point of a token-saving batch call.
				const { body, ...withoutBody } = r;
				const base = includeBody ? { ...withoutBody, body } : withoutBody;
				return [
					r.id as string,
					{
						...base,
						customFields: customFieldsByIssue[r.id as string] ?? [],
						url: buildIssueUrl(r),
					},
				];
			})
		);
	}

	// One item per distinct resolved+visible id, in first-requested order; every requested
	// ref/id that didn't resolve to an issue or isn't visible goes to `missing` instead —
	// under the identifier the caller used, never a resolved-but-invisible id.
	const items: Record<string, unknown>[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const entry of order) {
		const row = entry.id ? rowsById.get(entry.id) : undefined;
		if (!row) {
			if (!missing.includes(entry.requested)) missing.push(entry.requested);
			continue;
		}
		if (seen.has(entry.id as string)) continue;
		seen.add(entry.id as string);
		items.push(row);
	}

	return { items, missing };
}

async function resolveTypeId(
	ctx: ServiceCtx,
	typeId: string | null | undefined
): Promise<string | null> {
	if (typeId === null) return null;
	const orm = drizzle(ctx.db, { schema });
	if (typeId) {
		const found = await orm
			.select({ id: schema.taskTypes.id })
			.from(schema.taskTypes)
			.where(
				and(eq(schema.taskTypes.id, typeId), eq(schema.taskTypes.workspaceId, ctx.workspaceId))
			)
			.get();
		if (!found)
			throw new ValidationError({
				formErrors: ["Task type not found in this workspace"],
				fieldErrors: {},
			});
		return typeId;
	}
	const def = await orm
		.select({ id: schema.taskTypes.id })
		.from(schema.taskTypes)
		.where(
			and(eq(schema.taskTypes.workspaceId, ctx.workspaceId), eq(schema.taskTypes.isDefault, 1))
		)
		.get();
	return def?.id ?? null;
}

type CreateIssueData = z.infer<typeof CreateIssueSchema>;

// PROJ-870: build (without executing) the single INSERT that creates the issue row.
// status_category is bound directly from the category resolveStatus already read (no
// separate post-insert UPDATE re-looking it up), and RETURNING number hands back the
// atomically-allocated number without a follow-up SELECT. Kept as a raw ctx.db.prepare
// (like the pre-PROJ-870 version) since the number subquery isn't expressible through
// drizzle's insert builder.
function buildInsertIssueStatement(
	ctx: ServiceCtx,
	params: Readonly<{
		id: string;
		projectId: string;
		title: string;
		resolvedBody: string;
		resolvedStatusKey: string;
		resolvedStatusId: string | null;
		resolvedStatusCategory: string | null;
		priority: CreateIssueData["priority"];
		assigneeId: string | null;
		labels: string[];
		parentId: string | null;
		resolvedTypeId: string | null;
		// PROJ-921: set when the issue is created straight into a ready status.
		readyAt: number | null;
		now: number;
	}>
): D1PreparedStatement {
	// Atomic number allocation: the subquery for MAX(number) and the INSERT run as
	// a single SQLite statement, eliminating the read-then-write race that existed
	// when they were two separate operations. The UNIQUE index on (project_id, number)
	// is a hard safety net — see migration 0002_issue_number_unique.sql.
	return ctx.db
		.prepare(
			`INSERT INTO issues
			   (id, workspace_id, project_id, number, title, body, status, status_id,
			    status_category, priority, assignee_id, labels, parent_id, type_id,
			    created_by_id, author_kind, created_at, updated_at, dor_ready, dor_missing, ready_at)
			 VALUES
			   (?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM issues WHERE project_id = ?),
			    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 RETURNING number`
		)
		.bind(
			params.id,
			ctx.workspaceId,
			params.projectId,
			params.projectId,
			params.title,
			params.resolvedBody,
			params.resolvedStatusKey,
			params.resolvedStatusId ?? null,
			params.resolvedStatusCategory ?? "",
			params.priority ?? "none",
			params.assigneeId ?? null,
			JSON.stringify(params.labels ?? []),
			params.parentId ?? null,
			params.resolvedTypeId,
			ctx.userId,
			// PROJ-396: stamped from the authenticated principal type, not a caller-supplied
			// field — see ServiceCtx.authKind and the issueComments.authorKind precedent (PROJ-328).
			ctx.authKind ?? null,
			params.now,
			params.now,
			...dorColumns(params.resolvedBody),
			params.readyAt
		);
}

function buildFtsInsertStatement(
	ctx: ServiceCtx,
	id: string,
	title: string,
	body: string
): D1PreparedStatement {
	return ctx.db
		.prepare("INSERT INTO issues_fts (issue_id, workspace_id, title, body) VALUES (?, ?, ?, ?)")
		.bind(id, ctx.workspaceId, title, body);
}

// PROJ-870: build (without executing) an activity-log INSERT identical in shape to
// recordActivity's, so it can be folded into the caller's own ctx.db.batch() instead of
// being a separate awaited round trip. recordActivity itself is left unchanged for its
// other (non-batched) callers (wiki_page, project, group).
function buildActivityInsertStatement(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	opts: Readonly<{
		entityType: "issue";
		entityId: string;
		action: "created" | "updated";
		diff?: Record<string, unknown>;
	}>
): D1PreparedStatement {
	const query = orm
		.insert(schema.activity)
		.values({
			id: crypto.randomUUID(),
			workspaceId: ctx.workspaceId,
			entityType: opts.entityType,
			entityId: opts.entityId,
			actorId: ctx.userId,
			action: opts.action,
			diff: opts.diff ?? null,
			createdAt: now(),
		})
		.toSQL();
	return ctx.db.prepare(query.sql).bind(...query.params);
}

async function resolveCreateIssueDeps(ctx: ServiceCtx, data: CreateIssueData) {
	if (data.parentId) {
		await validateParent(ctx, data.parentId, null);
	}

	const resolvedTypeId = await resolveTypeId(ctx, data.typeId);
	const {
		id: resolvedStatusId,
		key: resolvedStatusKey,
		category: resolvedStatusCategory,
	} = await resolveStatus(ctx, data.statusId, data.status);
	const cfWrites = data.customFields
		? await validateCustomFields(ctx.db, ctx.workspaceId, data.customFields)
		: [];

	return { resolvedTypeId, resolvedStatusId, resolvedStatusKey, resolvedStatusCategory, cfWrites };
}

async function resolveTypeNameParam(
	ctx: ServiceCtx,
	type: string | undefined,
	typeId: string | null | undefined
): Promise<string | null | undefined> {
	if (type === undefined) return typeId;
	const orm = drizzle(ctx.db, { schema });
	const types = await orm
		.select({ id: schema.taskTypes.id, key: schema.taskTypes.key, name: schema.taskTypes.name })
		.from(schema.taskTypes)
		.where(eq(schema.taskTypes.workspaceId, ctx.workspaceId));
	const wanted = type.trim().toLowerCase();
	const match =
		types.find((t) => t.key.toLowerCase() === wanted) ??
		types.find((t) => t.name.toLowerCase() === wanted);
	if (!match) {
		const valid = types.map((t) => t.key).sort();
		throw new ValidationError({
			formErrors: [],
			fieldErrors: { type: [`Unknown type "${type}". Valid: ${valid.join(", ")}`] },
		});
	}
	if (typeId && typeId !== match.id) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: { type: [`type "${type}" conflicts with typeId; pass only one`] },
		});
	}
	return match.id;
}

export async function createIssue(ctx: ServiceCtx, raw: unknown) {
	const result = CreateIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const projectId = await resolveProjectIdParam(ctx, result.data.projectId);
	const parentId = result.data.parentId
		? await resolveIssueIdParam(ctx, result.data.parentId)
		: result.data.parentId;
	const typeId = await resolveTypeNameParam(ctx, result.data.type, result.data.typeId);
	const data = { ...result.data, projectId, parentId, typeId };
	const { title, body, priority, assigneeId, labels } = data;

	// PROJ-389: confirm projectId belongs to this workspace BEFORE the admin-bypass
	// check below, so an owner/admin can't write into another workspace's project.
	await requireProjectInWorkspace(ctx, projectId);

	// PROJ-311: writing requires a member/admin grant on this project (owner/admin
	// bypass). No grant → the project is invisible → 404; a viewer grant is read-only.
	if (!isWorkspaceAdmin(ctx.role)) {
		const projRole = await effectiveProjectRole(ctx, projectId);
		if (projRole === null) throw new NotFoundError("Project not found");
		if (!canWriteProject(projRole)) throw new ForbiddenError("Insufficient permissions");
	}

	// PROJ-785: an assignee must be a member of this workspace — otherwise we'd
	// persist a dangling or wrong-workspace user reference.
	if (assigneeId) {
		await requireWorkspaceMember(ctx, assigneeId);
	}

	const { resolvedTypeId, resolvedStatusId, resolvedStatusKey, resolvedStatusCategory, cfWrites } =
		await resolveCreateIssueDeps(ctx, data);

	const id = crypto.randomUUID();
	const nowTs = now();
	const resolvedBody = body ?? "";

	const orm = drizzle(ctx.db, { schema });

	// PROJ-870: everything below is independent of everything above it having already
	// happened (all validation/resolution reads are done), so the issue INSERT (with its
	// status_category computed inline and its allocated number returned), the FTS mirror
	// insert, the custom-field upserts, and the activity-log insert all go in one
	// ctx.db.batch() — one D1 round trip instead of up to 6 sequential ones.
	const statements: D1PreparedStatement[] = [
		buildInsertIssueStatement(ctx, {
			id,
			projectId,
			title,
			resolvedBody,
			resolvedStatusKey,
			resolvedStatusId,
			resolvedStatusCategory,
			priority,
			assigneeId: assigneeId ?? null,
			labels: labels ?? [],
			parentId: parentId ?? null,
			resolvedTypeId,
			readyAt: isOpenPastBacklog(resolvedStatusKey, resolvedStatusCategory) ? nowTs : null,
			now: nowTs,
		}),
		buildFtsInsertStatement(ctx, id, title, resolvedBody),
		...buildCustomFieldUpsertStatements(ctx.db, id, cfWrites),
		buildActivityInsertStatement(ctx, orm, {
			entityType: "issue",
			entityId: id,
			action: "created",
		}),
	];

	const results = await ctx.db.batch(statements);
	const number = (results[0]?.results as Array<{ number: number }> | undefined)?.[0]?.number;

	if (parentId) {
		await cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${parentId}`);
	}

	await broadcastWorkspaceEvent(ctx, {
		type: "issue.created",
		projectId: data.projectId,
		data: { id, number, title: data.title, status: resolvedStatusKey ?? "todo" },
	});

	return { id, number };
}

type UpdateIssueData = z.infer<typeof UpdateIssueSchema>;
type ExistingIssue = {
	id: string;
	parentId: string | null;
	typeId: string | null;
	title: string;
	body: string;
	status: string;
	statusCategory: string | null;
	readyAt: number | null;
	claimedAt: number | null;
	doneAt: number | null;
	completionReportAt: number | null;
	inReviewAt: number | null;
	reviewBounceCount: number;
	// PROJ-749: whether the issue's current status is a designated review step.
	statusIsReviewStep: boolean;
};

// biome-ignore lint/suspicious/noExplicitAny: Drizzle set() requires typed columns; setValues is safe
type SetValues = Record<string, any>;

function buildSimpleFields(data: UpdateIssueData): SetValues {
	const setValues: SetValues = {};
	if (data.title !== undefined) setValues.title = data.title;
	if (data.body !== undefined) {
		setValues.body = data.body;
		// PROJ-859: keep the stored definition-of-ready result in step with the body.
		const [dorReady, dorMissing] = dorColumns(data.body);
		setValues.dorReady = dorReady;
		setValues.dorMissing = dorMissing;
	}
	if (data.priority !== undefined) setValues.priority = data.priority;
	if ("assigneeId" in data) setValues.assigneeId = data.assigneeId ?? null;
	if (data.labels !== undefined) setValues.labels = data.labels;
	if ("parentId" in data) setValues.parentId = data.parentId ?? null;
	return setValues;
}

// PROJ-212: stamp completed_at when an issue first enters a done-category
// status, clear it when it leaves. We keep the original completion time if
// the issue was already done and is merely re-saved. Done is detected from
// either the configured status category or the legacy `status` enum, so it
// works whether or not the workspace uses custom task statuses.
function buildCompletedAtTransition(
	existing: ExistingIssue,
	resolvedStatusKey: string,
	newStatusCategory: string | undefined
): SetValues {
	const wasDone = existing.statusCategory === "done" || existing.status === "done";
	const isDone = newStatusCategory === "done" || resolvedStatusKey === "done";
	if (isDone && !wasDone) return { completedAt: now() };
	if (!isDone && wasDone) return { completedAt: null };
	return {};
}

// PROJ-252 flow metrics: stamp ready_at/claimed_at/done_at the first time an issue
// enters the corresponding state, using the same category-or-legacy-key detection as
// applyCompletedAtTransition. Unlike completed_at these are write-once — never cleared
// on re-entry — so lead/cycle time still reflects rework after a reopen. "Ready" isn't
// its own status_category (backlog and todo share category 'todo'), so it's detected
// from the legacy `status` key instead: any status other than 'backlog'.
function isClaimedState(
	category: string | null | undefined,
	key: string | null | undefined,
	isReviewStep: boolean
): boolean {
	return category === "in_progress" || key === "in_progress" || isReviewStep;
}

function isDoneState(category: string | null | undefined, key: string | null | undefined): boolean {
	return category === "done" || key === "done";
}

function isCancelledState(
	category: string | null | undefined,
	key: string | null | undefined
): boolean {
	return category === "cancelled" || key === "cancelled";
}

// PROJ-921: an issue becomes "ready" when it leaves backlog for an open status —
// todo/ready, or straight into in_progress (PROJ-252: a fast-tracked issue was ready the
// moment it was picked up, so its lead time equals its cycle time). Going straight from
// backlog to done or cancelled in one update is NOT a ready transition: that issue never
// waited to be worked, and used to get ready_at = done_at, a 0s lead time that dragged
// the median to zero. Issues created in an open non-backlog status are ready from creation.
function isOpenPastBacklog(key: string, category: string | null | undefined): boolean {
	if (key === "backlog" || key === "cancelled" || category === "cancelled") return false;
	return !isDoneState(category, key);
}

function buildFlowTimestampTransitions(
	existing: ExistingIssue,
	resolvedStatusKey: string,
	newStatusCategory: string | undefined,
	newIsReviewStep: boolean
): SetValues {
	const setValues: SetValues = {};

	if (existing.readyAt == null && isOpenPastBacklog(resolvedStatusKey, newStatusCategory)) {
		setValues.readyAt = now();
	}

	const wasClaimed = isClaimedState(
		existing.statusCategory,
		existing.status,
		existing.statusIsReviewStep
	);
	const isClaimed = isClaimedState(newStatusCategory, resolvedStatusKey, newIsReviewStep);
	if (isClaimed && !wasClaimed && existing.claimedAt == null) setValues.claimedAt = now();

	const wasDone = isDoneState(existing.statusCategory, existing.status);
	const isDone = isDoneState(newStatusCategory, resolvedStatusKey);
	if (isDone && !wasDone && existing.doneAt == null) setValues.doneAt = now();

	return setValues;
}

// PROJ-328 (collaboration-shape metrics): stamp in_review_at the first time an issue
// enters a review status (write-once, same rule as applyFlowTimestampTransitions), and
// count a bounce every time it leaves review back to non-review, non-done — the "a human
// sent it back for more work" signal for the human-interventions metric. "Entering
// review" is detected the same way the review gate (PROJ-292) detects it: isReviewStatusKey,
// not status_category (there is no dedicated in_review category).
//
// PROJ-334: also reports whether this specific transition is a "gate rejection" —
// in_review -> in_progress, narrower than reviewBounceCount above (which also counts
// review -> cancelled as a bounce). The factory-health tile wants the literal rework
// signal the ticket names ("in_review -> in_progress bounces"), not "left review for any
// reason", so review -> cancelled (the issue was killed, not sent back for more work)
// must not count here even though it still increments the aggregate.
function buildReviewTransitions(
	existing: ExistingIssue,
	transition: Readonly<{
		resolvedStatusKey: string;
		newStatusCategory: string | undefined;
		newIsReviewStep: boolean;
		enteringInReview: boolean;
		enteringDone: boolean;
	}>
): { setValues: SetValues; isGateRejection: boolean } {
	const { resolvedStatusKey, newStatusCategory, newIsReviewStep, enteringInReview, enteringDone } =
		transition;
	const setValues: SetValues = {};
	if (enteringInReview && existing.inReviewAt == null) setValues.inReviewAt = now();

	const wasInReview = existing.statusIsReviewStep;
	const leavingReviewNotDone = wasInReview && !newIsReviewStep && !enteringDone;
	if (leavingReviewNotDone) setValues.reviewBounceCount = existing.reviewBounceCount + 1;

	const isGateRejection =
		leavingReviewNotDone &&
		(newStatusCategory === "in_progress" || resolvedStatusKey === "in_progress");
	return { setValues, isGateRejection };
}

function assertCompletionReportPresent(data: UpdateIssueData): void {
	if (!data.completionReport) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: {
				completionReport: [
					"completionReport.summary and completionReport.verification are required for an agent to enter review (PROJ-254)",
				],
			},
		});
	}
}

// Pure classification of what this status change is entering, shared by the gate
// (what to enforce) and the completion-report stamp (PROJ-293 — stamp/post only on a
// real transition, not on any update that happens to carry a completionReport).
//
// PROJ-749 (supersedes PROJ-292's /review/i key match): a review step is the status's
// explicit task_statuses.is_review_step flag. Matching the key let any status merely
// *named* like a review ("contract_review", "legal_review") acquire the completion-report
// gate and pollute review flow metrics. Migration 0061 backfilled the flag from the old
// rule, so existing custom review statuses ("code_review", "peer_review") keep the gate.
function classifyStatusTransition(
	existing: ExistingIssue,
	resolvedStatusKey: string,
	newStatusCategory: string | undefined,
	newIsReviewStep: boolean
): { enteringInReview: boolean; enteringDone: boolean } {
	const wasInReview = existing.statusIsReviewStep;
	const enteringInReview = newIsReviewStep && !wasInReview;

	const wasDone = existing.statusCategory === "done" || existing.status === "done";
	const enteringDone = (newStatusCategory === "done" || resolvedStatusKey === "done") && !wasDone;
	return { enteringInReview, enteringDone };
}

// PROJ-254/287/289/292, relaxed by PROJ-375: entering review while an agent holds a
// live lease requires a completion report; the done-report requirement applies only
// to issues an agent has actually worked, so ordinary human closes (duplicates,
// won't-fix, chores) aren't blocked. PROJ-375 removed the old hard block on an agent
// (live lease) transitioning to done — agents can close freely now; see
// computeNeedsAudit below for the audit-after-the-fact replacement.
async function assertReviewGate(
	ctx: ServiceCtx,
	data: UpdateIssueData,
	existing: ExistingIssue,
	transition: Readonly<{ enteringInReview: boolean; enteringDone: boolean }>
): Promise<void> {
	const { enteringInReview, enteringDone } = transition;
	if (!enteringInReview && !enteringDone) return;

	if (enteringInReview) {
		const hasLiveAgentLease = await issueHasLiveAgentLease(ctx, existing.id);
		if (hasLiveAgentLease) {
			assertCompletionReportPresent(data);
		}
	}

	if (enteringDone) {
		const everAgentWorked = await issueEverHadAgentLease(ctx, existing.id);
		if (everAgentWorked && existing.completionReportAt == null && !data.completionReport) {
			throw new ValidationError({
				formErrors: [
					"A completion report is required before an agent-worked issue can be marked done (PROJ-254)",
				],
				fieldErrors: {},
			});
		}
	}
}

// PROJ-375: audit-after-the-fact replacement for the removed done-gate block. Only
// flags a call that's actually agent-initiated — `isLiveAgentSessionId` checks the
// session is real and live, not just a self-declared string, so a caller can't get
// flagged/unflagged by lease state (the bug that started this ticket: an agent that
// released its lease before closing slipped the old gate unintentionally). A caller
// can still dodge the flag by omitting agentSessionId entirely — accepted limitation,
// see the module doc on evidence-classification.ts.
async function computeNeedsAudit(ctx: ServiceCtx, data: UpdateIssueData): Promise<boolean> {
	if (!data.agentSessionId) return false;
	if (!(await isLiveAgentSessionId(ctx, data.agentSessionId))) return false;
	if (!data.completionReport) return true;
	return !isExternallyVerifiableEvidence(data.completionReport.verification);
}

async function applyStatusFields(
	ctx: ServiceCtx,
	data: UpdateIssueData,
	existing: ExistingIssue
): Promise<{
	setValues: SetValues;
	reviewOrDoneTransition: boolean;
	enteringDone: boolean;
	// PROJ-962: closed (done/cancelled) now and not before — unlike `closing`, a re-save of an
	// already-closed issue doesn't count, so it can't re-trigger the parent-epic check.
	enteringClosed: boolean;
	gateRejectionStatement: D1PreparedStatement | null;
	// PROJ-928: resolved to done/cancelled by category OR legacy key — a workspace with
	// no custom task_statuses row backing this key has category === null (see
	// resolveStatus), so status_category alone would miss the legacy-key case.
	closing: boolean;
}> {
	if (data.status === undefined && !("statusId" in data)) {
		return {
			setValues: {},
			reviewOrDoneTransition: false,
			enteringDone: false,
			enteringClosed: false,
			gateRejectionStatement: null,
			closing: false,
		};
	}

	// PROJ-870: resolveStatus returns the category from the same row lookup that resolves
	// the status id/key, replacing the separate fetchStatusCategory re-query of that id and
	// the COALESCE((SELECT category ...)) subquery that used to sit in the UPDATE.
	const resolved = await resolveStatus(
		ctx,
		"statusId" in data ? data.statusId : undefined,
		data.status
	);
	const { id: resolvedStatusId, key: resolvedStatusKey } = resolved;
	const newStatusCategory = resolved.category ?? undefined;

	const newIsReviewStep = resolved.isReviewStep;
	const transition = classifyStatusTransition(
		existing,
		resolvedStatusKey,
		newStatusCategory,
		newIsReviewStep
	);
	await assertReviewGate(ctx, data, existing, transition);

	const setValues: SetValues = {
		status: resolvedStatusKey,
		statusId: resolvedStatusId,
		statusCategory: resolved.category ?? "",
	};
	if (transition.enteringDone) {
		setValues.needsAudit = await computeNeedsAudit(ctx, data);
	}

	Object.assign(
		setValues,
		buildCompletedAtTransition(existing, resolvedStatusKey, newStatusCategory)
	);
	Object.assign(
		setValues,
		buildFlowTimestampTransitions(existing, resolvedStatusKey, newStatusCategory, newIsReviewStep)
	);
	const { setValues: reviewSetValues, isGateRejection } = buildReviewTransitions(existing, {
		resolvedStatusKey,
		newStatusCategory,
		newIsReviewStep,
		enteringInReview: transition.enteringInReview,
		enteringDone: transition.enteringDone,
	});
	Object.assign(setValues, reviewSetValues);
	// PROJ-334/PROJ-870: recorded as its own event, built here but not executed — folded
	// into the caller's single ctx.db.batch() alongside the issue UPDATE. Batching it
	// (rather than the pre-PROJ-870 stray extra await) is strictly safer than before: the
	// batch is one atomic transaction, so the rejection row and the status change can no
	// longer disagree (either both land or neither does), whereas the old comment's "a
	// stray extra row on a later failure is harmless" was tolerating exactly the gap this
	// closes.
	const gateRejectionStatement = isGateRejection
		? ctx.db
				.prepare(
					"INSERT INTO issue_gate_rejections (id, workspace_id, issue_id, occurred_at) VALUES (?, ?, ?, ?)"
				)
				.bind(crypto.randomUUID(), ctx.workspaceId, existing.id, now())
		: null;

	return {
		setValues,
		reviewOrDoneTransition: transition.enteringInReview || transition.enteringDone,
		enteringDone: transition.enteringDone,
		enteringClosed:
			(isDoneState(newStatusCategory, resolvedStatusKey) ||
				isCancelledState(newStatusCategory, resolvedStatusKey)) &&
			!isDoneState(existing.statusCategory, existing.status) &&
			!isCancelledState(existing.statusCategory, existing.status),
		gateRejectionStatement,
		closing:
			isDoneState(newStatusCategory, resolvedStatusKey) ||
			isCancelledState(newStatusCategory, resolvedStatusKey),
	};
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

// The completion report is posted as a comment, so the formatted body has to satisfy the
// comment body limit. addComment used to enforce that (after the issue UPDATE had already
// been written); the batched insert doesn't re-validate, so check it here, before the
// batch, and fail the whole update with a 400 instead of storing an oversize comment.
function completionReportCommentBody(
	report: Parameters<typeof formatCompletionReportComment>[0],
	revised = false
): string {
	const body = formatCompletionReportComment(report, revised);
	const max = AddCommentSchema.shape.body.maxLength;
	if (max !== null && body.length > max) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: {
				completionReport: [
					`Completion report is too long: it is posted as a comment, which is limited to ${max} characters (this one formats to ${body.length})`,
				],
			},
		});
	}
	return body;
}

function formatCompletionReportComment(
	report: Readonly<{
		summary: string;
		verification: string;
		prLink?: string;
		remainder?: string;
	}>,
	revised = false
): string {
	const lines = [
		revised ? "**Completion report (revised)**" : "**Completion report**",
		"",
		`**Summary:** ${report.summary}`,
		"",
		`**Verification:** ${report.verification}`,
	];
	if (report.prLink) lines.push("", `**PR:** ${report.prLink}`);
	if (report.remainder) lines.push("", `**Remainder (not done):** ${report.remainder}`);
	return lines.join("\n");
}

// PROJ-571: changing an epic's type away from Epic silently orphans its children
// from the epic UI/rollups (parentId is untouched, but nothing surfaces the epic
// view for them anymore). Block it at the service layer so REST and MCP both get
// the guard, rather than only a frontend confirm dialog.
async function assertNotDemotingEpicWithChildren(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	existing: ExistingIssue,
	newTypeId: string | null
): Promise<void> {
	if (!existing.typeId || existing.typeId === newTypeId) return;

	const currentType = await orm
		.select({ key: schema.taskTypes.key })
		.from(schema.taskTypes)
		.where(
			and(
				eq(schema.taskTypes.id, existing.typeId),
				eq(schema.taskTypes.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (currentType?.key !== "epic") return;

	const childCount = await orm.$count(
		schema.issues,
		and(eq(schema.issues.parentId, existing.id), eq(schema.issues.workspaceId, ctx.workspaceId))
	);
	if (childCount > 0) {
		throw new ValidationError({
			formErrors: [
				"Cannot change type: this epic still has child issues — move or remove them first",
			],
			fieldErrors: {},
		});
	}
}

async function buildUpdateSetValues(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	data: UpdateIssueData,
	existing: ExistingIssue
): Promise<{
	setValues: SetValues;
	recordCompletionReport: boolean;
	reviseCompletionReport: boolean;
	enteringDone: boolean;
	enteringClosed: boolean;
	gateRejectionStatement: D1PreparedStatement | null;
	closing: boolean;
}> {
	const setValues: SetValues = { updatedAt: now(), ...buildSimpleFields(data) };
	const statusFields = await applyStatusFields(ctx, data, existing);
	Object.assign(setValues, statusFields.setValues);
	const reviewOrDoneTransition = statusFields.reviewOrDoneTransition;
	if ("typeId" in data) {
		const resolvedTypeId = await resolveTypeId(ctx, data.typeId);
		await assertNotDemotingEpicWithChildren(ctx, orm, existing, resolvedTypeId);
		setValues.typeId = resolvedTypeId;
	}
	// PROJ-293: only stamp/post the report when the issue actually transitions into
	// review or done — a title-only update carrying a completionReport must not
	// pre-stamp completion_report_at (which would later satisfy the human-done gate).
	const recordCompletionReport = Boolean(data.completionReport) && reviewOrDoneTransition;
	if (recordCompletionReport) {
		setValues.completionReportAt = now();
	}
	const statusMoves =
		"statusId" in data || (data.status !== undefined && data.status !== existing.status);
	const reviseCompletionReport =
		Boolean(data.completionReport) &&
		!reviewOrDoneTransition &&
		!statusMoves &&
		(isDoneState(existing.statusCategory, existing.status) || existing.statusIsReviewStep);
	if (reviseCompletionReport && data.agentSessionId) {
		if (isDoneState(existing.statusCategory, existing.status)) {
			setValues.needsAudit = await computeNeedsAudit(ctx, data);
		}
	}
	if (data.completionReport && !statusMoves && !reviseCompletionReport && !recordCompletionReport) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: {
				completionReport: [
					"completionReport only applies when entering in_review/done, or revising a finished issue",
				],
			},
		});
	}
	return {
		setValues,
		recordCompletionReport,
		reviseCompletionReport,
		enteringDone: statusFields.enteringDone,
		enteringClosed: statusFields.enteringClosed,
		gateRejectionStatement: statusFields.gateRejectionStatement,
		closing: statusFields.closing,
	};
}

// PROJ-870: build (without executing) the FTS delete+insert pair using title/body already
// known from the caller (either the new value being written, or the existing row's value
// fetched alongside `existing` at the top of updateIssue) — no re-SELECT of the row that
// was just written, unlike the pre-PROJ-870 version.
function buildFtsReindexStatements(
	ctx: ServiceCtx,
	id: string,
	title: string,
	body: string
): D1PreparedStatement[] {
	return [
		ctx.db
			.prepare("DELETE FROM issues_fts WHERE issue_id = ? AND workspace_id = ?")
			.bind(id, ctx.workspaceId),
		ctx.db
			.prepare("INSERT INTO issues_fts (issue_id, workspace_id, title, body) VALUES (?, ?, ?, ?)")
			.bind(id, ctx.workspaceId, title, body),
	];
}

// PROJ-869: body can be arbitrarily large and is already persisted on the issue row
// itself and re-indexed into issues_fts on every update — storing it again in `diff`
// (kept for the activity retention window) is the dominant source of the `activity`
// table's growth. Record just that body changed, not the text itself; every other field
// here is a small scalar, so those keep recording the actual (new) value.
function buildUpdateDiffCore(data: UpdateIssueData): Record<string, unknown> {
	const diff: Record<string, unknown> = {};
	if (data.title !== undefined) diff.title = data.title;
	if (data.body !== undefined) diff.bodyChanged = true;
	if (data.status !== undefined) diff.status = data.status;
	if (data.priority !== undefined) diff.priority = data.priority;
	if (data.labels !== undefined) diff.labels = data.labels;
	return diff;
}

function buildUpdateDiffRefs(data: UpdateIssueData): Record<string, unknown> {
	const diff: Record<string, unknown> = {};
	if ("statusId" in data) diff.statusId = data.statusId ?? null;
	if ("assigneeId" in data) diff.assigneeId = data.assigneeId ?? null;
	if ("parentId" in data) diff.parentId = data.parentId ?? null;
	if ("typeId" in data) diff.typeId = data.typeId ?? null;
	if (data.customFields !== undefined) diff.customFields = data.customFields;
	return diff;
}

async function invalidateUpdateCaches(
	ctx: ServiceCtx,
	id: string,
	data: UpdateIssueData,
	existing: ExistingIssue
): Promise<void> {
	await cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${id}`);

	// Invalidate the old parent's rollup cache
	if (existing.parentId) {
		await cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${existing.parentId}`);
	}
	// If parentId is being changed to a new parent, also invalidate that one
	if ("parentId" in data && data.parentId && data.parentId !== existing.parentId) {
		await cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${data.parentId}`);
	}
}

export async function updateIssue(ctx: ServiceCtx, rawId: string, raw: unknown) {
	const id = await resolveIssueIdParam(ctx, rawId);
	const result = UpdateIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(flattenWithPaths(result.error));
	const data =
		"parentId" in result.data && result.data.parentId
			? { ...result.data, parentId: await resolveIssueIdParam(ctx, result.data.parentId) }
			: result.data;

	if ("parentId" in data && data.parentId) {
		await validateParent(ctx, data.parentId, id);
	}

	const orm = drizzle(ctx.db, { schema });

	const existingRow = await orm
		.select({
			id: schema.issues.id,
			projectId: schema.issues.projectId,
			parentId: schema.issues.parentId,
			typeId: schema.issues.typeId,
			title: schema.issues.title,
			body: schema.issues.body,
			status: schema.issues.status,
			statusCategory: schema.issues.statusCategory,
			readyAt: schema.issues.readyAt,
			claimedAt: schema.issues.claimedAt,
			doneAt: schema.issues.doneAt,
			completionReportAt: schema.issues.completionReportAt,
			inReviewAt: schema.issues.inReviewAt,
			reviewBounceCount: schema.issues.reviewBounceCount,
			statusReviewFlag: schema.taskStatuses.isReviewStep,
		})
		.from(schema.issues)
		.leftJoin(
			schema.taskStatuses,
			and(
				eq(schema.taskStatuses.id, schema.issues.statusId),
				eq(schema.taskStatuses.workspaceId, ctx.workspaceId)
			)
		)
		.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (!existingRow) throw new NotFoundError("Issue not found");
	// PROJ-749: a status row's flag decides; without one only the built-in "in_review" counts.
	const { statusReviewFlag, ...existingFields } = existingRow;
	const existing = {
		...existingFields,
		statusIsReviewStep:
			statusReviewFlag == null ? existingRow.status === "in_review" : statusReviewFlag === 1,
	};

	// PROJ-311: gate the write on the effective project role (owner/admin bypass).
	// No grant → invisible → 404; a viewer grant is read-only → 403.
	if (!isWorkspaceAdmin(ctx.role)) {
		const projRole = await effectiveProjectRole(ctx, existing.projectId);
		if (projRole === null) throw new NotFoundError("Issue not found");
		if (!canWriteProject(projRole)) throw new ForbiddenError("Insufficient permissions");
	}

	// PROJ-785: a non-null assigneeId must be a member of this workspace —
	// otherwise we'd persist a dangling or wrong-workspace user reference. `null`
	// (clearing the assignee) and "not provided" (key absent) both skip this.
	if ("assigneeId" in data && data.assigneeId) {
		await requireWorkspaceMember(ctx, data.assigneeId);
	}

	const {
		setValues,
		recordCompletionReport,
		reviseCompletionReport,
		enteringDone,
		enteringClosed,
		gateRejectionStatement,
		closing,
	} = await buildUpdateSetValues(ctx, orm, data, existing);

	// PROJ-870: custom-field writes are validated (read) before the batch, same as before,
	// but the upserts themselves are now built as statements and folded in below instead of
	// looping one round trip per field.
	const cfWrites =
		data.customFields && Object.keys(data.customFields).length > 0
			? await validateCustomFields(ctx.db, ctx.workspaceId, data.customFields)
			: [];

	const commentId = crypto.randomUUID();
	const commentNow = now();
	const diff = { ...buildUpdateDiffCore(data), ...buildUpdateDiffRefs(data) };

	// PROJ-870: the issue UPDATE (status_category included, from resolveStatus), the FTS delete+insert, the custom-field upserts, the completion-report
	// comment insert, the gate-rejection insert, and the activity-log insert are all
	// independent writes derived from data resolved above — fold them into one
	// ctx.db.batch() instead of up to ~10 sequential round trips.
	const updateStatement = toD1Statement(
		ctx,
		orm
			.update(schema.issues)
			.set(setValues)
			.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
			.toSQL()
	);

	const statements: D1PreparedStatement[] = [updateStatement];

	if (data.title !== undefined || data.body !== undefined) {
		statements.push(
			...buildFtsReindexStatements(
				ctx,
				id,
				data.title ?? existing.title,
				data.body ?? existing.body
			)
		);
	}

	statements.push(...buildCustomFieldUpsertStatements(ctx.db, id, cfWrites));

	if ((recordCompletionReport || reviseCompletionReport) && data.completionReport) {
		statements.push(
			buildAddCommentInsertStatement(ctx, orm, {
				id: commentId,
				issueId: id,
				body: completionReportCommentBody(data.completionReport, reviseCompletionReport),
				now: commentNow,
			})
		);
	}

	if (gateRejectionStatement) statements.push(gateRejectionStatement);

	statements.push(
		buildActivityInsertStatement(ctx, orm, {
			entityType: "issue",
			entityId: id,
			action: "updated",
			diff,
		})
	);

	// PROJ-928: an issue moving to done/cancelled releases its lease and file claims so
	// they don't keep blocking the fleet after the work they were guarding is over — folded
	// into this same batch (PROJ-870 convention) rather than a separate round trip. `closing`
	// is only computed when this update actually carries a status/statusId change (see
	// applyStatusFields' early return), so a title-only save of an already-closed issue
	// never reaches here; re-saving status=done again is a harmless no-op release.
	if (closing) {
		statements.push(
			buildReleaseLeaseForClosedIssueStatement(ctx, id),
			buildReleaseClaimsForClosedIssueStatement(ctx, id)
		);
	}

	// PROJ-929: a call that carries a live agentSessionId implicitly refreshes that
	// session's heartbeat, same as claim_issue/claim_files/post_message. Folded into this
	// same batch (PROJ-870 convention) rather than a separate round trip; the statement's
	// own WHERE guard (status='active' AND heartbeat > cutoff) makes it a no-op if the
	// session went stale between this check and the batch executing.
	if (data.agentSessionId && (await isLiveAgentSessionId(ctx, data.agentSessionId))) {
		statements.push(buildTouchAgentHeartbeatIfLiveStatement(ctx, data.agentSessionId));
	}

	await ctx.db.batch(statements);

	if ((recordCompletionReport || reviseCompletionReport) && data.completionReport) {
		await broadcastWorkspaceEvent(ctx, {
			type: "comment.created",
			projectId: existing.projectId,
			data: { id: commentId, issueId: id, authorId: ctx.userId },
		});
	}

	await invalidateUpdateCaches(ctx, id, data, existing);

	const isStatusChange = data.status !== undefined || data.statusId !== undefined;
	await broadcastWorkspaceEvent(ctx, {
		type: isStatusChange ? "issue.status_changed" : "issue.updated",
		projectId: existing.projectId ?? undefined,
		data: { id, updates: data },
	});

	// PROJ-961: a done-transition that reports a remainder spawns the follow-up.
	const remainder = data.completionReport?.remainder;
	let followUp: { id: string; ref: string } | undefined;
	let followUpError: string | undefined;
	if (remainder && enteringDone) {
		// The issue is already saved as done by now, so a failure here (e.g. the parent lives
		// in a project the caller can't see) is reported rather than thrown: throwing would
		// present a committed write as failed, and a retry can't recreate the follow-up.
		try {
			followUp = await createRemainderFollowUp(ctx, orm, existing, remainder);
		} catch (e) {
			followUpError = `Issue saved as done, but the follow-up for the remainder could not be created: ${
				e instanceof Error ? e.message : String(e)
			}. Create it manually.`;
		}
	}

	// PROJ-962: runs after the follow-up exists, so an open follow-up under the same epic
	// keeps it from being reported ready (or closed) while work remains. Only on a real
	// transition into done/cancelled, never a re-save of an already-closed child.
	const parent = enteringClosed ? await handleLastChildClosed(ctx, orm, existing) : undefined;

	return {
		ok: true,
		...(followUp ? { followUp } : {}),
		...(followUpError ? { followUpError } : {}),
		...(parent ?? {}),
	};
}

// PROJ-962: when the last open child of an epic is done/cancelled, either close the epic
// (project.epicAutoClose) or tell the caller it is ready: `parentReadyToClose:{ref}` is the
// default so a human/agent still decides; `parentClosed:{ref}` reports an automatic close.
async function handleLastChildClosed(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	existing: ExistingIssue & { projectId: string }
): Promise<
	{ parentReadyToClose: { ref: string } } | { parentClosed: { ref: string } } | undefined
> {
	if (!existing.parentId) return undefined;
	const parent = await orm
		.select({
			id: schema.issues.id,
			number: schema.issues.number,
			status: schema.issues.status,
			statusCategory: schema.issues.statusCategory,
			typeKey: schema.taskTypes.key,
			projectKey: schema.projects.key,
			epicAutoClose: schema.projects.epicAutoClose,
			projectId: schema.issues.projectId,
		})
		.from(schema.issues)
		.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.leftJoin(
			schema.taskTypes,
			and(
				eq(schema.taskTypes.id, schema.issues.typeId),
				eq(schema.taskTypes.workspaceId, ctx.workspaceId)
			)
		)
		.where(
			and(eq(schema.issues.id, existing.parentId), eq(schema.issues.workspaceId, ctx.workspaceId))
		)
		.get();
	if (parent?.typeKey !== "epic") return undefined;
	// The response must not reveal an epic (key + number) in a project the caller can't see,
	// and an automatic close needs write access there like any other close would.
	let canWrite = isWorkspaceAdmin(ctx.role);
	if (!canWrite) {
		const role = await effectiveProjectRole(ctx, parent.projectId);
		if (role === null) return undefined;
		canWrite = canWriteProject(role);
	}
	if (isDoneState(parent.statusCategory, parent.status)) return undefined;
	if (isCancelledState(parent.statusCategory, parent.status)) return undefined;

	// Open = neither done nor cancelled, by category or by legacy key (see isDoneState).
	const open = await orm.$count(
		schema.issues,
		and(
			eq(schema.issues.parentId, parent.id),
			eq(schema.issues.workspaceId, ctx.workspaceId),
			notInArray(schema.issues.statusCategory, ["done", "cancelled"]),
			notInArray(schema.issues.status, ["done", "cancelled"])
		)
	);
	if (open > 0) return undefined;

	const ref = `${parent.projectKey}-${parent.number}`;
	if (!parent.epicAutoClose || !canWrite) return { parentReadyToClose: { ref } };
	try {
		await updateIssue(ctx, parent.id, { status: "done" });
	} catch {
		// The child's close is already saved; a gate on the epic (e.g. a completion report
		// required for an agent-worked issue) must not turn that into an error. Fall back to
		// the hint so the caller can close the epic with its own report.
		return { parentReadyToClose: { ref } };
	}
	return { parentClosed: { ref } };
}

// PROJ-961: the work an agent reports as not done becomes its own issue — same parent
// (so it stays under the epic) and labels, linked follows_from the original — instead of
// living in a comment nobody triages. Runs after the update batch: only a real transition
// to done reaches it, so a retried done-update can't create a second follow-up.
async function createRemainderFollowUp(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	existing: ExistingIssue & { projectId: string },
	remainder: string
): Promise<{ id: string; ref: string }> {
	const row = await orm
		.select({
			labels: schema.issues.labels,
			number: schema.issues.number,
			projectKey: schema.projects.key,
		})
		.from(schema.issues)
		.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.where(and(eq(schema.issues.id, existing.id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	const originalRef = row ? `${row.projectKey}-${row.number}` : existing.id;
	const created = await createIssue(ctx, {
		projectId: existing.projectId,
		title: `Follow-up: ${existing.title}`.slice(0, 500),
		body: `Remainder from ${originalRef} (marked done):\n\n${remainder}`,
		labels: Array.isArray(row?.labels) ? row.labels : [],
		...(existing.parentId ? { parentId: existing.parentId } : {}),
	});
	await createLink(ctx, {
		sourceIssueId: created.id,
		targetIssueId: existing.id,
		type: "follows_from",
	});
	return { id: created.id, ref: `${row?.projectKey ?? ""}-${created.number}` };
}

export async function deleteIssue(ctx: ServiceCtx, rawId: string) {
	const id = await resolveIssueIdParam(ctx, rawId);
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	const orm = drizzle(ctx.db, { schema });

	const existing = await orm
		.select({ parentId: schema.issues.parentId, projectId: schema.issues.projectId })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	// PROJ-922: every dependent-row statement below keys on this id, several without a
	// workspace filter of their own — so the id MUST be proven to be in this workspace
	// first, or an admin of workspace A could wipe workspace B's comments/links/files by
	// passing one of B's issue UUIDs.
	if (!existing) throw new NotFoundError("Issue not found");

	// PROJ-311: deletion needs admin inside the project — workspace owner/admin bypass
	// groups; everyone else needs a project-admin grant.
	if (!isWorkspaceAdmin(ctx.role)) {
		const projRole = await effectiveProjectRole(ctx, existing.projectId);
		if (projRole !== "admin") throw new ForbiddenError("Insufficient permissions");
	}

	// PROJ-922: D1 does not reliably enforce the FK ON DELETE CASCADE/SET NULL declared in
	// the schema (PROJ-407), so every row that references this issue must be cleaned up
	// explicitly here, in the same batch as the issue row itself — final list from
	// grepping packages/db/migrations for `REFERENCES issues`, plus two references that
	// exist without a physical FK constraint (issues.parent_id, attachments' polymorphic
	// entity_type/entity_id) but the same dangling-reference risk.
	//
	// R2 objects for "file"-kind attachments hanging directly off this issue
	// (entity_type='issue') are looked up before the batch (their D1 rows are deleted in
	// it) and removed only after the batch commits, so a failed batch never leaves
	// attachment metadata pointing at bytes we already destroyed.
	const fileAttachments = await orm
		.select({ r2Key: schema.attachments.r2Key })
		.from(schema.attachments)
		.where(
			and(
				eq(schema.attachments.workspaceId, ctx.workspaceId),
				eq(schema.attachments.entityType, "issue"),
				eq(schema.attachments.entityId, id),
				eq(schema.attachments.kind, "file")
			)
		);
	// Issues whose cached payload mentions this one (link targets/sources, children) —
	// invalidated after the batch so they stop showing a deleted issue.
	const affected = await ctx.db
		.prepare(
			`SELECT target_issue_id AS id FROM issue_links WHERE source_issue_id = ?1
			 UNION SELECT source_issue_id FROM issue_links WHERE target_issue_id = ?1
			 UNION SELECT id FROM issues WHERE parent_id = ?1 AND workspace_id = ?2`
		)
		.bind(id, ctx.workspaceId)
		.all<{ id: string }>();

	const deleteStatements: D1PreparedStatement[] = [
		toD1Statement(
			ctx,
			orm
				.delete(schema.issues)
				.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
				.toSQL()
		),
		ctx.db
			.prepare("DELETE FROM issues_fts WHERE issue_id = ? AND workspace_id = ?")
			.bind(id, ctx.workspaceId),
		// share_tokens has no FK at all (0017), so nothing ever removed a deleted issue's
		// public share links.
		ctx.db
			.prepare("DELETE FROM share_tokens WHERE issue_id = ? AND workspace_id = ?")
			.bind(id, ctx.workspaceId),
		ctx.db
			.prepare("DELETE FROM agent_messages WHERE scope = ?1 AND workspace_id = ?2")
			.bind(`issue:${id}`, ctx.workspaceId),
		// ON DELETE CASCADE rows — delete outright.
		toD1Statement(
			ctx,
			orm.delete(schema.issueComments).where(eq(schema.issueComments.issueId, id)).toSQL()
		),
		toD1Statement(
			ctx,
			orm
				.delete(schema.issueLinks)
				.where(or(eq(schema.issueLinks.sourceIssueId, id), eq(schema.issueLinks.targetIssueId, id)))
				.toSQL()
		),
		toD1Statement(
			ctx,
			orm.delete(schema.customFieldValues).where(eq(schema.customFieldValues.issueId, id)).toSQL()
		),
		toD1Statement(
			ctx,
			orm.delete(schema.issueFileClaims).where(eq(schema.issueFileClaims.issueId, id)).toSQL()
		),
		toD1Statement(
			ctx,
			orm.delete(schema.issueLeases).where(eq(schema.issueLeases.issueId, id)).toSQL()
		),
		toD1Statement(
			ctx,
			orm
				.delete(schema.claimConflicts)
				.where(
					or(
						eq(schema.claimConflicts.rejectedIssueId, id),
						eq(schema.claimConflicts.holdingIssueId, id)
					)
				)
				.toSQL()
		),
		toD1Statement(
			ctx,
			orm.delete(schema.wipCapDenials).where(eq(schema.wipCapDenials.issueId, id)).toSQL()
		),
		toD1Statement(
			ctx,
			orm
				.delete(schema.issueGateRejections)
				.where(eq(schema.issueGateRejections.issueId, id))
				.toSQL()
		),
		toD1Statement(
			ctx,
			orm
				.delete(schema.attachments)
				.where(
					and(
						eq(schema.attachments.workspaceId, ctx.workspaceId),
						eq(schema.attachments.entityType, "issue"),
						eq(schema.attachments.entityId, id)
					)
				)
				.toSQL()
		),
		// ON DELETE SET NULL rows — null the referencing column instead.
		toD1Statement(
			ctx,
			orm
				.update(schema.agentSessions)
				.set({ issueId: null })
				.where(
					and(
						eq(schema.agentSessions.issueId, id),
						eq(schema.agentSessions.workspaceId, ctx.workspaceId)
					)
				)
				.toSQL()
		),
		ctx.db
			.prepare(
				"UPDATE feedback SET linked_issue_id = NULL WHERE linked_issue_id = ? AND workspace_id = ?"
			)
			.bind(id, ctx.workspaceId),
		// Not a physically-declared FK (issues.parent_id carries no REFERENCES clause), but
		// the same dangling-reference risk: null child issues' parent_id.
		toD1Statement(
			ctx,
			orm
				.update(schema.issues)
				.set({ parentId: null })
				.where(and(eq(schema.issues.parentId, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
				.toSQL()
		),
	];

	await ctx.db.batch(deleteStatements);

	// The issue is gone once the batch commits; failing to remove its R2 bytes now only
	// leaks storage, so log it rather than failing the request. One call for all keys.
	const r2Keys = fileAttachments.map((a) => a.r2Key).filter((k): k is string => Boolean(k));
	if (r2Keys.length > 0) {
		try {
			await ctx.r2.delete(r2Keys);
		} catch (err) {
			console.error("deleteIssue: R2 cleanup failed", {
				id,
				count: r2Keys.length,
				err: String(err),
			});
		}
	}

	await recordActivity(ctx, { entityType: "issue", entityId: id, action: "deleted" });
	const toInvalidate = new Set([id, ...affected.results.map((r) => r.id)]);
	if (existing.parentId) toInvalidate.add(existing.parentId);
	await Promise.all(
		[...toInvalidate].map((iid) => cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${iid}`))
	);

	await broadcastWorkspaceEvent(ctx, {
		type: "issue.deleted",
		projectId: existing.projectId,
		data: { id },
	});

	return { ok: true };
}

const _PRIORITY_SCORE: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

type PrioritizedFilters = {
	limit: number;
	includeBacklog: boolean;
	excludeClaimed: boolean;
	includeNotReady: boolean;
	projectId: string | undefined;
};

function parsePrioritizedFilters(raw: unknown): PrioritizedFilters {
	const input = raw as {
		limit?: unknown;
		includeBacklog?: unknown;
		excludeClaimed?: unknown;
		includeNotReady?: unknown;
		projectId?: unknown;
	};
	// PROJ-920: MCP clients may send "5" / "false" (the arg validator allows what the
	// services coerce), so parse like BooleanQueryParam / z.coerce rather than comparing
	// with === true / !== false, which read the string "false" as true.
	const flag = (v: unknown, fallback: boolean): boolean => {
		const parsed = BooleanQueryParam.safeParse(v);
		return parsed.success ? parsed.data : fallback;
	};
	const rawLimit = typeof input.limit === "string" ? Number(input.limit) : input.limit;
	const limit =
		typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
			? Math.min(Math.floor(rawLimit), 100)
			: 10;
	const includeBacklog = flag(input.includeBacklog, true);
	const excludeClaimed = flag(input.excludeClaimed, false);
	const includeNotReady = flag(input.includeNotReady, false);
	const projectId =
		typeof input.projectId === "string" && input.projectId ? input.projectId : undefined;
	return { limit, includeBacklog, excludeClaimed, includeNotReady, projectId };
}

// PROJ-859: fill in dor_ready/dor_missing for rows written before migration 0058.
// One-time per row (writes keep the columns current afterwards), in bounded batches so
// a large workspace heals over a few calls instead of one huge request. Steady state
// is a single indexed SELECT that returns nothing.
const DOR_HEAL_BATCH = 200;
const DOR_HEAL_MAX_BATCHES = 5;

async function healDefinitionOfReady(ctx: ServiceCtx): Promise<void> {
	for (let i = 0; i < DOR_HEAL_MAX_BATCHES; i++) {
		const { results } = await ctx.db
			.prepare("SELECT id, body FROM issues WHERE workspace_id = ? AND dor_ready IS NULL LIMIT ?")
			.bind(ctx.workspaceId, DOR_HEAL_BATCH)
			.all<{ id: string; body: string | null }>();
		const rows = results ?? [];
		if (rows.length === 0) return;
		await ctx.db.batch(
			rows.map((r) =>
				ctx.db
					.prepare(
						"UPDATE issues SET dor_ready = ?, dor_missing = ? WHERE id = ? AND workspace_id = ?"
					)
					.bind(...dorColumns(r.body), r.id, ctx.workspaceId)
			)
		);
		if (rows.length < DOR_HEAL_BATCH) return;
	}
}

interface PrioritizedRow {
	id: string;
	title: string;
	status: string;
	priority: string;
	project_id: string;
	number: number;
	status_id: string | null;
	status_category: string | null;
	dor_ready: number | null;
	dor_missing: string | null;
	centrality: number;
	priority_score: number;
	story_points: number;
	score: number;
	not_ready_count: number;
}

/**
 * PROJ-859: candidate selection AND ranking in one SQL statement.
 *
 * Same composite as before — 0.4·centrality + 0.4·priority/4 + 0.2·(1/story points),
 * centrality = in-degree / max in-degree over the open set — but computed by SQLite
 * with window functions, so the Worker only ever receives `limit` rows and no bodies.
 * The window aggregates (max in-degree, not-ready count) run over the full open set
 * BEFORE the ready filter, exactly as the old in-memory version scored everything and
 * filtered afterwards. Ties break on insertion order (rowid).
 */
async function queryPrioritized(
	ctx: ServiceCtx,
	opts: {
		limit: number;
		includeBacklog: boolean;
		excludeClaimed: boolean;
		projectId: string | undefined;
		readyOnly: boolean;
	}
): Promise<PrioritizedRow[]> {
	const where: string[] = [
		"i.workspace_id = ?",
		`((i.status_id IS NULL AND i.status NOT IN ('done', 'cancelled'))
		  OR (i.status_id IS NOT NULL AND ts.category NOT IN ('done', 'cancelled')))`,
	];
	const params: unknown[] = [ctx.workspaceId];
	if (opts.projectId) {
		where.push("i.project_id = ?");
		params.push(opts.projectId);
	}
	// PROJ-311: only prioritize issues in projects the user can see.
	const visible = visibleProjectSqlFragment(ctx, "i.project_id");
	if (visible) {
		where.push(visible.sql);
		params.push(...visible.params);
	}
	if (!opts.includeBacklog) where.push("i.status != 'backlog'");
	// PROJ-184: skip issues held by a live lease.
	if (opts.excludeClaimed) {
		where.push(`NOT EXISTS (
			SELECT 1 FROM issue_leases l JOIN agent_sessions s ON s.id = l.agent_session_id
			WHERE l.workspace_id = i.workspace_id AND l.issue_id = i.id AND l.released_at IS NULL
			  AND s.status = 'active' AND s.last_heartbeat_at > ?)`);
		params.push(Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS);
	}

	const sqlText = `
		WITH open AS (
			SELECT i.id, i.title, i.status, i.priority, i.project_id, i.number, i.status_id,
			       ts.category AS status_category, i.dor_ready, i.dor_missing, i.rowid AS rid,
			       (SELECT COUNT(*) FROM issue_links l
			         WHERE l.workspace_id = i.workspace_id AND l.target_issue_id = i.id) AS indeg,
			       (SELECT CAST(v.value AS REAL) FROM custom_field_values v
			          JOIN custom_field_definitions d ON d.id = v.field_id
			         WHERE v.issue_id = i.id AND CAST(v.value AS REAL) > 0
			           AND (d.key LIKE '%story%' OR d.key LIKE '%point%'
			                OR d.label LIKE '%story%' OR d.label LIKE '%point%')
			         ORDER BY v.rowid DESC LIMIT 1) AS sp
			  FROM issues i
			  LEFT JOIN task_statuses ts ON ts.id = i.status_id
			 WHERE ${where.join(" AND ")}
		),
		scored AS (
			SELECT *,
			       CAST(indeg AS REAL) / MAX(MAX(indeg) OVER (), 1) AS centrality,
			       (CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2
			                      WHEN 'low' THEN 1 ELSE 0 END) / 4.0 AS priority_score,
			       COALESCE(sp, 1) AS story_points,
			       SUM(CASE WHEN dor_ready = 0 THEN 1 ELSE 0 END) OVER () AS not_ready_count
			  FROM open
		)
		SELECT *, 0.4 * centrality + 0.4 * priority_score + 0.2 * (1.0 / story_points) AS score
		  FROM scored
		 ${opts.readyOnly ? "WHERE dor_ready = 1" : ""}
		 ORDER BY score DESC, rid ASC
		 LIMIT ?`;
	params.push(opts.limit);

	const { results } = await ctx.db
		.prepare(sqlText)
		.bind(...params)
		.all<PrioritizedRow>();
	return results ?? [];
}

function toPrioritizedIssue(r: PrioritizedRow) {
	const issue = {
		id: r.id,
		title: r.title,
		status: r.status,
		priority: r.priority,
		project_id: r.project_id,
		number: r.number,
		status_id: r.status_id,
		status_category: r.status_category,
		_score: r.score,
		_score_breakdown: {
			centrality: r.centrality,
			priority: r.priority_score,
			story_points: r.story_points,
		},
	};
	if (r.dor_ready === 1) return issue;
	return {
		...issue,
		needsGrooming: true as const,
		missingCriteria: JSON.parse(r.dor_missing ?? "[]") as string[],
	};
}

export async function getPrioritizedIssues(ctx: ServiceCtx, raw: unknown) {
	const parsed = parsePrioritizedFilters(raw);
	const { limit, includeBacklog, excludeClaimed, includeNotReady } = parsed;
	const projectId = parsed.projectId
		? await resolveVisibleProjectIdParam(ctx, parsed.projectId)
		: parsed.projectId;

	await healDefinitionOfReady(ctx);
	const base = { limit, includeBacklog, excludeClaimed, projectId };

	// PROJ-253: definition-of-ready gate. By default, issues missing acceptance
	// criteria/scope are dropped from "what should I work on next?" — an agent that
	// claims one is set up to guess. includeNotReady surfaces them anyway, annotated
	// with what's missing, for grooming.
	if (includeNotReady) {
		const rows = await queryPrioritized(ctx, { ...base, readyOnly: false });
		if (rows.length === 0) return { issues: [] };
		return { issues: rows.map(toPrioritizedIssue), droppedNotReady: 0 };
	}

	const ready = await queryPrioritized(ctx, { ...base, readyOnly: true });
	// PROJ-291: don't SILENTLY drop not-ready issues — surface the count so a caller
	// seeing few results knows to groom (or re-query with includeNotReady).
	if (ready.length > 0) {
		return { issues: ready.map(toPrioritizedIssue), droppedNotReady: ready[0].not_ready_count };
	}

	// Nothing ready: return the ranked not-ready list, flagged, rather than an empty
	// array that reads as "no open work".
	const all = await queryPrioritized(ctx, { ...base, readyOnly: false });
	if (all.length === 0) return { issues: [] };
	return {
		issues: all.map(toPrioritizedIssue),
		droppedNotReady: all[0].not_ready_count,
		degraded: true,
	};
}

export async function searchIssues(ctx: ServiceCtx, raw: unknown) {
	const result = SearchIssuesInputSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { query, limit } = result.data;
	const projectId = result.data.projectId
		? await resolveVisibleProjectIdParam(ctx, result.data.projectId)
		: result.data.projectId;

	// Everything both queries below share, applied to issues aliased `i`: the optional
	// project, the caller's visible projects (PROJ-311), and the PROJ-960 label filter.
	let scope = "";
	const scopeParams: unknown[] = [];
	if (projectId) {
		scope += " AND i.project_id = ?";
		scopeParams.push(projectId);
	}
	const visible = visibleProjectSqlFragment(ctx, "i.project_id");
	if (visible) {
		scope += ` AND ${visible.sql}`;
		scopeParams.push(...visible.params);
	}
	const labelScope = labelFilterSql("i.labels", result.data);
	scope += labelScope.sql;
	scopeParams.push(...labelScope.params);

	const columns = `i.id, i.number, i.title, i.status, i.priority,
	              p.id as project_id, p.key as project_key, p.name as project_name`;

	// PROJ-960: the FTS index covers title and body only, so searching for a label's text
	// found nothing even when dozens of issues carried it. An issue whose label equals the
	// whole query (case-insensitive) is an exact hit, so those lead the results.
	const trimmed = query.trim();
	// A label is at most 50 characters (schemas/issues.ts), so a longer query can't be one —
	// skip the json_each scan, which no index backs, for prose queries.
	const mayBeLabel = trimmed.length > 0 && trimmed.length <= MAX_LABEL_LENGTH;
	const labelHits = !mayBeLabel
		? []
		: (
				await ctx.db
					.prepare(
						`SELECT ${columns}
				 FROM issues i
				 LEFT JOIN projects p ON p.id = i.project_id
				 WHERE i.workspace_id = ?
				   AND EXISTS (SELECT 1 FROM json_each(${labelsJsonSql("i.labels")}) WHERE lower(value) = lower(?))
				   ${scope}
				 ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
					)
					.bind(ctx.workspaceId, trimmed, ...scopeParams, limit)
					.all<{ id: string }>()
			).results;

	const ftsQuery = sanitizeFtsQuery(query);
	const ftsHits = ftsQuery
		? (
				await ctx.db
					.prepare(
						`SELECT ${columns}
						 FROM issues_fts
						 JOIN issues i ON i.id = issues_fts.issue_id
						 LEFT JOIN projects p ON p.id = i.project_id
						 WHERE issues_fts MATCH ? AND issues_fts.workspace_id = ?
						   ${scope}
						 ORDER BY bm25(issues_fts) LIMIT ?`
					)
					.bind(ftsQuery, ctx.workspaceId, ...scopeParams, limit)
					.all<{ id: string }>()
			).results
		: [];

	const seen = new Set<string>();
	const merged: Array<{ id: string }> = [];
	for (const row of [...labelHits, ...ftsHits]) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		merged.push(row);
		if (merged.length >= limit) break;
	}
	return merged;
}
