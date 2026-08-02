import { drizzle, schema } from "@projektor/db";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lte,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type { z } from "zod";
import { issuePath } from "../lib/urls";
import { IdSchema } from "../schemas/common";
import {
	CreateIssueSchema,
	GetIssueSchema,
	ListIssuesSchema,
	SearchIssuesInputSchema,
	UpdateIssueSchema,
} from "../schemas/issues";
import {
	canWriteProject,
	effectiveProjectRole,
	isWorkspaceAdmin,
	requireProjectInWorkspace,
	visibleProjectPredicate,
	visibleProjectSqlFragment,
} from "./access";
import { recordActivity } from "./activity";
import * as cache from "./cache";
import { addComment } from "./comments";
import {
	batchLoadCustomFields,
	validateCustomFields,
	writeCustomFieldValues,
} from "./custom-fields";
import { checkDefinitionOfReady } from "./definition-of-ready";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { isExternallyVerifiableEvidence } from "./evidence-classification";
import {
	isLiveAgentSessionId,
	issueEverHadAgentLease,
	issueHasLiveAgentLease,
	liveLeasedIssueIds,
} from "./issue-leases";
import { listLinksForIssue } from "./issue-links";
import { inChunks, sanitizeFtsQuery } from "./sql";
import { resolveStatus } from "./task-statuses";
import type { ServiceCtx } from "./types";

const ISSUE_TTL = 300;

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

	const orm = drizzle(ctx.db, { schema });

	const parentRow = await orm
		.select({ id: schema.issues.id, parentId: schema.issues.parentId })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, parentId), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();

	if (!parentRow) throw new NotFoundError("Parent issue not found");

	// Walk up the ancestor chain: count how many ancestors the parent has.
	// If the parent already has 5 ancestors, the child would be at depth 6 — exceeds the cap.
	let currentId: string | null = parentRow.parentId;
	let ancestorCount = 0;

	while (currentId !== null) {
		if (issueId && currentId === issueId) {
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

		const row = await orm
			.select({ id: schema.issues.id, parentId: schema.issues.parentId })
			.from(schema.issues)
			.where(and(eq(schema.issues.id, currentId), eq(schema.issues.workspaceId, ctx.workspaceId)))
			.get();

		currentId = row?.parentId ?? null;
	}
}

type ListIssuesFilters = z.infer<typeof ListIssuesSchema>;

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
		if (ids.length) conditions.push(inArray(schema.issues.statusId, ids));
	}
	if (category) conditions.push(eq(schema.issues.statusCategory, category));
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
	await addCustomFieldFilter(orm, ctx, conditions, filters);
	addDateRangeFilters(conditions, filters);
	return conditions;
}

export async function listIssues(ctx: ServiceCtx, raw: unknown) {
	const result = ListIssuesSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const filters = result.data;
	const { limit } = filters;

	const orm = drizzle(ctx.db, { schema });

	// Conditions exclude the pagination cursor, so they represent the full filtered set —
	// used as-is for the total count, and extended with the cursor below for the page query.
	const conditions = await buildListIssuesConditions(orm, ctx, filters);
	const pageConditions = filters.cursor
		? [...conditions, sql`${schema.issues.createdAt} < ${filters.cursor}`]
		: conditions;

	const totalRow = await orm
		.select({ count: sql<number>`count(*)` })
		.from(schema.issues)
		.where(and(...conditions))
		.get();
	const total = totalRow?.count ?? 0;

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
		.orderBy(desc(schema.issues.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const lastItem = items[items.length - 1] as { created_at: number } | undefined;
	const nextCursor = hasMore && lastItem ? lastItem.created_at : null;

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
const issueColumns = {
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
} as const;

async function fetchIssueById(orm: ReturnType<typeof drizzle>, ctx: ServiceCtx, id: string) {
	return (
		(await orm
			.select(issueColumns)
			.from(schema.issues)
			.leftJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
			.leftJoin(schema.taskTypes, eq(schema.issues.typeId, schema.taskTypes.id))
			.leftJoin(schema.taskStatuses, eq(schema.issues.statusId, schema.taskStatuses.id))
			.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
			.get()) ?? null
	);
}

// Digits are bounded: parseInt("9".repeat(400)) is Infinity, which drizzle would happily
// bind and D1 would reject as a type error — a 500 where a 404 belongs. Anything longer
// than this isn't a ref, so it falls through to being treated as an id and 404s.
export const ISSUE_REF_PATTERN = /^([A-Z][A-Z0-9]*)-(\d{1,9})$/;

/**
 * Accept either identifier in an `:issueId` path segment.
 *
 * PROJ-438: only `GET /api/issues/:id` understood a ref, so a browser landing on
 * /projects/KEY/N/… had to resolve the UUID and only then ask for that issue's comments
 * and links — a full round trip of dead time on the critical path, per sub-resource.
 *
 * This resolves within `ctx.workspaceId` only, and answers "not found" for a ref that
 * doesn't, so it can't be used to probe for issues in another workspace.
 *
 * It does NOT check project visibility. Both current callers hand the returned id
 * straight to a service that does (PROJ-311), and duplicating the check here would be a
 * second place to get it wrong. If you add a caller, confirm that holds for yours too —
 * an id from this function is workspace-scoped and nothing more.
 */
export async function resolveIssueIdParam(ctx: ServiceCtx, param: string): Promise<string> {
	const m = param.match(ISSUE_REF_PATTERN);
	if (!m) return param;

	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.where(
			and(
				eq(schema.projects.key, m[1]),
				eq(schema.issues.number, parseInt(m[2], 10)),
				eq(schema.issues.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!row) throw new NotFoundError("Issue not found");
	return row.id;
}

async function fetchIssueByRef(orm: ReturnType<typeof drizzle>, ctx: ServiceCtx, ref: string) {
	const m = ref.match(ISSUE_REF_PATTERN);
	if (!m)
		throw new ValidationError({
			formErrors: ["ref must be in format KEY-NUMBER"],
			fieldErrors: {},
		});
	return (
		(await orm
			.select(issueColumns)
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

// The cache is keyed by issue id, not user — re-check visibility so a member can't
// read an entry warmed by an admin.
async function getVisibleCachedIssue(
	ctx: ServiceCtx,
	issueId: string
): Promise<Record<string, unknown> | null> {
	const cached = await cache.get<Record<string, unknown>>(
		ctx.kv,
		`issue:${ctx.workspaceId}:${issueId}`
	);
	if (!cached) return null;
	await assertIssueProjectVisible(ctx, cached.project_id as string);
	return cached;
}

async function fetchIssueByIdOrRef(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	id: string | undefined,
	ref: string | undefined
) {
	if (id) return fetchIssueById(orm, ctx, id);
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

async function assembleFullIssue(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	issueId: string,
	issueRecord: Record<string, unknown>
) {
	type ChildCount = { status: string; count: number };
	const childRows = (await orm.all(
		sql`SELECT status, COUNT(*) as count FROM issues
			WHERE parent_id = ${issueId} AND workspace_id = ${ctx.workspaceId}
			GROUP BY status`
	)) as ChildCount[];

	const rollup = computeChildRollup(childRows);

	const links = await listLinksForIssue(ctx, { issueId });

	const customFieldsByIssue = await batchLoadCustomFields(ctx.db, ctx.workspaceId, [issueId]);
	const customFields = customFieldsByIssue[issueId] ?? [];

	return {
		...issueRecord,
		rollup,
		links,
		customFields,
		url: buildIssueUrl(issueRecord),
	};
}

export async function getIssue(ctx: ServiceCtx, raw: unknown) {
	const result = GetIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { id, ref } = result.data;

	if (id) {
		const cached = await getVisibleCachedIssue(ctx, id);
		if (cached) return cached;
	}

	const orm = drizzle(ctx.db, { schema });

	const issue = await fetchIssueByIdOrRef(orm, ctx, id, ref);
	if (!issue) throw new NotFoundError("Issue not found");

	await assertIssueProjectVisible(ctx, (issue as Record<string, unknown>).project_id as string);

	const issueId = (issue as Record<string, unknown>).id as string;

	// PROJ-359: a ref lookup ("PROJ-42" — the primary MCP agent read path) resolves
	// via fetchIssueByRef above rather than the id-keyed cache check at the top of
	// this function, so it never got any cache benefit and paid for a KV write on
	// every single call. Now that the id is known, check the cache before paying
	// for the rollup/links/custom-fields queries below.
	if (ref) {
		const cached = await cache.get<Record<string, unknown>>(
			ctx.kv,
			`issue:${ctx.workspaceId}:${issueId}`
		);
		if (cached) return cached;
	}

	const fullIssue = await assembleFullIssue(ctx, orm, issueId, issue as Record<string, unknown>);

	await cache.set(ctx.kv, `issue:${ctx.workspaceId}:${issueId}`, fullIssue, ISSUE_TTL);

	return fullIssue;
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

async function insertIssueRow(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	params: Readonly<{
		id: string;
		projectId: string;
		title: string;
		resolvedBody: string;
		resolvedStatusKey: string;
		resolvedStatusId: string | null;
		priority: CreateIssueData["priority"];
		assigneeId: string | null;
		labels: string[];
		parentId: string | null;
		resolvedTypeId: string | null;
		now: number;
	}>
): Promise<void> {
	// Atomic number allocation: the subquery for MAX(number) and the INSERT run as
	// a single SQLite statement, eliminating the read-then-write race that existed
	// when they were two separate operations. The UNIQUE index on (project_id, number)
	// is a hard safety net — see migration 0002_issue_number_unique.sql.
	await ctx.db
		.prepare(
			`INSERT INTO issues
			   (id, workspace_id, project_id, number, title, body, status, status_id,
			    status_category, priority, assignee_id, labels, parent_id, type_id,
			    created_by_id, author_kind, created_at, updated_at)
			 VALUES
			   (?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM issues WHERE project_id = ?),
			    ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			params.now
		)
		.run();

	await orm
		.update(schema.issues)
		.set({
			statusCategory: sql`COALESCE((SELECT category FROM task_statuses WHERE id = ${params.resolvedStatusId}), '')`,
		})
		.where(eq(schema.issues.id, params.id));

	await ctx.db
		.prepare("INSERT INTO issues_fts (issue_id, workspace_id, title, body) VALUES (?, ?, ?, ?)")
		.bind(params.id, ctx.workspaceId, params.title, params.resolvedBody)
		.run();
}

async function resolveCreateIssueDeps(ctx: ServiceCtx, data: CreateIssueData) {
	if (data.parentId) {
		await validateParent(ctx, data.parentId, null);
	}

	const resolvedTypeId = await resolveTypeId(ctx, data.typeId);
	const { id: resolvedStatusId, key: resolvedStatusKey } = await resolveStatus(
		ctx,
		data.statusId,
		data.status
	);
	const cfWrites = data.customFields
		? await validateCustomFields(ctx.db, ctx.workspaceId, data.customFields)
		: [];

	return { resolvedTypeId, resolvedStatusId, resolvedStatusKey, cfWrites };
}

async function finalizeCreateIssue(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	id: string,
	parentId: string | null | undefined,
	cfWrites: Awaited<ReturnType<typeof validateCustomFields>>
) {
	if (cfWrites.length > 0) {
		await writeCustomFieldValues(ctx.db, id, cfWrites);
	}

	const row = await orm
		.select({ number: schema.issues.number })
		.from(schema.issues)
		.where(eq(schema.issues.id, id))
		.get();
	await recordActivity(ctx, { entityType: "issue", entityId: id, action: "created" });

	if (parentId) {
		await cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${parentId}`);
	}

	return row;
}

export async function createIssue(ctx: ServiceCtx, raw: unknown) {
	const result = CreateIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const data = result.data;
	const { projectId, title, body, priority, assigneeId, labels, parentId } = data;

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

	const { resolvedTypeId, resolvedStatusId, resolvedStatusKey, cfWrites } =
		await resolveCreateIssueDeps(ctx, data);

	const id = crypto.randomUUID();
	const nowTs = now();
	const resolvedBody = body ?? "";

	const orm = drizzle(ctx.db, { schema });

	await insertIssueRow(ctx, orm, {
		id,
		projectId,
		title,
		resolvedBody,
		resolvedStatusKey,
		resolvedStatusId,
		priority,
		assigneeId: assigneeId ?? null,
		labels: labels ?? [],
		parentId: parentId ?? null,
		resolvedTypeId,
		now: nowTs,
	});

	const row = await finalizeCreateIssue(ctx, orm, id, parentId, cfWrites);

	return { id, number: row?.number };
}

type UpdateIssueData = z.infer<typeof UpdateIssueSchema>;
type ExistingIssue = {
	id: string;
	parentId: string | null;
	status: string;
	statusCategory: string | null;
	readyAt: number | null;
	claimedAt: number | null;
	doneAt: number | null;
	completionReportAt: number | null;
	inReviewAt: number | null;
	reviewBounceCount: number;
};

// biome-ignore lint/suspicious/noExplicitAny: Drizzle set() requires typed columns; setValues is safe
type SetValues = Record<string, any>;

function buildSimpleFields(data: UpdateIssueData): SetValues {
	const setValues: SetValues = {};
	if (data.title !== undefined) setValues.title = data.title;
	if (data.body !== undefined) setValues.body = data.body;
	if (data.priority !== undefined) setValues.priority = data.priority;
	if ("assigneeId" in data) setValues.assigneeId = data.assigneeId ?? null;
	if (data.labels !== undefined) setValues.labels = data.labels;
	if ("parentId" in data) setValues.parentId = data.parentId ?? null;
	return setValues;
}

async function fetchStatusCategory(
	orm: ReturnType<typeof drizzle>,
	resolvedStatusId: string | null
): Promise<string | undefined> {
	if (!resolvedStatusId) return undefined;
	const row = await orm
		.select({ category: schema.taskStatuses.category })
		.from(schema.taskStatuses)
		.where(eq(schema.taskStatuses.id, resolvedStatusId))
		.get();
	return row?.category;
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
	key: string | null | undefined
): boolean {
	return category === "in_progress" || key === "in_progress" || key === "in_review";
}

function isDoneState(category: string | null | undefined, key: string | null | undefined): boolean {
	return category === "done" || key === "done";
}

function buildFlowTimestampTransitions(
	existing: ExistingIssue,
	resolvedStatusKey: string,
	newStatusCategory: string | undefined
): SetValues {
	const setValues: SetValues = {};

	const wasReady = existing.status !== "backlog";
	if (resolvedStatusKey !== "backlog" && !wasReady && existing.readyAt == null) {
		setValues.readyAt = now();
	}

	const wasClaimed = isClaimedState(existing.statusCategory, existing.status);
	const isClaimed = isClaimedState(newStatusCategory, resolvedStatusKey);
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
		enteringInReview: boolean;
		enteringDone: boolean;
	}>
): { setValues: SetValues; isGateRejection: boolean } {
	const { resolvedStatusKey, newStatusCategory, enteringInReview, enteringDone } = transition;
	const setValues: SetValues = {};
	if (enteringInReview && existing.inReviewAt == null) setValues.inReviewAt = now();

	const wasInReview = isReviewStatusKey(existing.status);
	const leavingReviewNotDone =
		wasInReview && !isReviewStatusKey(resolvedStatusKey) && !enteringDone;
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
					"summary and verification are required for an agent to enter review (PROJ-254)",
				],
			},
		});
	}
}

// PROJ-292: a review step is identified by its status key naming a review, NOT by a
// dedicated category — there is no 'in_review' category (the default review status is
// category 'in_progress'), and keying on the single literal "in_review" let a
// workspace's custom review status (e.g. "code-review", "peer_review") slip the gate.
function isReviewStatusKey(key: string | undefined): boolean {
	return key != null && /review/i.test(key);
}

// Pure classification of what this status change is entering, shared by the gate
// (what to enforce) and the completion-report stamp (PROJ-293 — stamp/post only on a
// real transition, not on any update that happens to carry a completionReport).
function classifyStatusTransition(
	existing: ExistingIssue,
	resolvedStatusKey: string,
	newStatusCategory: string | undefined
): { enteringInReview: boolean; enteringDone: boolean } {
	const wasInReview = isReviewStatusKey(existing.status);
	const enteringInReview = isReviewStatusKey(resolvedStatusKey) && !wasInReview;

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
	orm: ReturnType<typeof drizzle>,
	data: UpdateIssueData,
	existing: ExistingIssue
): Promise<{ setValues: SetValues; reviewOrDoneTransition: boolean }> {
	if (data.status === undefined && !("statusId" in data)) {
		return { setValues: {}, reviewOrDoneTransition: false };
	}

	const { id: resolvedStatusId, key: resolvedStatusKey } = await resolveStatus(
		ctx,
		"statusId" in data ? data.statusId : undefined,
		data.status
	);

	const newStatusCategory = await fetchStatusCategory(orm, resolvedStatusId);
	const transition = classifyStatusTransition(existing, resolvedStatusKey, newStatusCategory);
	await assertReviewGate(ctx, data, existing, transition);

	const setValues: SetValues = {
		status: resolvedStatusKey,
		statusId: resolvedStatusId,
		statusCategory: sql`COALESCE((SELECT category FROM task_statuses WHERE id = ${resolvedStatusId}), '')`,
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
		buildFlowTimestampTransitions(existing, resolvedStatusKey, newStatusCategory)
	);
	const { setValues: reviewSetValues, isGateRejection } = buildReviewTransitions(existing, {
		resolvedStatusKey,
		newStatusCategory,
		enteringInReview: transition.enteringInReview,
		enteringDone: transition.enteringDone,
	});
	Object.assign(setValues, reviewSetValues);
	// PROJ-334: recorded as its own event (not batched into the setValues UPDATE below)
	// so it carries its own occurred_at, the same reasoning file-claims.ts insertClaims
	// uses for D1's lack of interactive transactions — a stray extra row on a later
	// failure is harmless, an unrecorded rejection is not.
	if (isGateRejection) {
		await ctx.db
			.prepare(
				"INSERT INTO issue_gate_rejections (id, workspace_id, issue_id, occurred_at) VALUES (?, ?, ?, ?)"
			)
			.bind(crypto.randomUUID(), ctx.workspaceId, existing.id, now())
			.run();
	}

	return {
		setValues,
		reviewOrDoneTransition: transition.enteringInReview || transition.enteringDone,
	};
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

function formatCompletionReportComment(
	report: Readonly<{
		summary: string;
		verification: string;
		prLink?: string;
	}>
): string {
	const lines = [
		"**Completion report**",
		"",
		`**Summary:** ${report.summary}`,
		"",
		`**Verification:** ${report.verification}`,
	];
	if (report.prLink) lines.push("", `**PR:** ${report.prLink}`);
	return lines.join("\n");
}

async function buildUpdateSetValues(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	data: UpdateIssueData,
	existing: ExistingIssue
): Promise<{ setValues: SetValues; recordCompletionReport: boolean }> {
	const setValues: SetValues = { updatedAt: now(), ...buildSimpleFields(data) };
	const statusFields = await applyStatusFields(ctx, orm, data, existing);
	Object.assign(setValues, statusFields.setValues);
	const reviewOrDoneTransition = statusFields.reviewOrDoneTransition;
	if ("typeId" in data) {
		setValues.typeId = await resolveTypeId(ctx, data.typeId);
	}
	// PROJ-293: only stamp/post the report when the issue actually transitions into
	// review or done — a title-only update carrying a completionReport must not
	// pre-stamp completion_report_at (which would later satisfy the human-done gate).
	const recordCompletionReport = Boolean(data.completionReport) && reviewOrDoneTransition;
	if (recordCompletionReport) {
		setValues.completionReportAt = now();
	}
	return { setValues, recordCompletionReport };
}

async function reindexIssueFts(
	ctx: ServiceCtx,
	orm: ReturnType<typeof drizzle>,
	id: string,
	data: UpdateIssueData
): Promise<void> {
	if (data.title === undefined && data.body === undefined) return;

	const current = await orm
		.select({ title: schema.issues.title, body: schema.issues.body })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (!current) return;

	await ctx.db
		.prepare("DELETE FROM issues_fts WHERE issue_id = ? AND workspace_id = ?")
		.bind(id, ctx.workspaceId)
		.run();
	await ctx.db
		.prepare("INSERT INTO issues_fts (issue_id, workspace_id, title, body) VALUES (?, ?, ?, ?)")
		.bind(id, ctx.workspaceId, current.title, current.body)
		.run();
}

async function applyCustomFieldUpdates(
	ctx: ServiceCtx,
	id: string,
	data: UpdateIssueData
): Promise<void> {
	if (!data.customFields || Object.keys(data.customFields).length === 0) return;
	const cfWrites = await validateCustomFields(ctx.db, ctx.workspaceId, data.customFields);
	await writeCustomFieldValues(ctx.db, id, cfWrites);
}

function buildUpdateDiffCore(data: UpdateIssueData): Record<string, unknown> {
	const diff: Record<string, unknown> = {};
	if (data.title !== undefined) diff.title = data.title;
	if (data.body !== undefined) diff.body = data.body;
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

export async function updateIssue(ctx: ServiceCtx, id: string, raw: unknown) {
	const result = UpdateIssueSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const data = result.data;

	if ("parentId" in data && data.parentId) {
		await validateParent(ctx, data.parentId, id);
	}

	const orm = drizzle(ctx.db, { schema });

	const existing = await orm
		.select({
			id: schema.issues.id,
			projectId: schema.issues.projectId,
			parentId: schema.issues.parentId,
			status: schema.issues.status,
			statusCategory: schema.issues.statusCategory,
			readyAt: schema.issues.readyAt,
			claimedAt: schema.issues.claimedAt,
			doneAt: schema.issues.doneAt,
			completionReportAt: schema.issues.completionReportAt,
			inReviewAt: schema.issues.inReviewAt,
			reviewBounceCount: schema.issues.reviewBounceCount,
		})
		.from(schema.issues)
		.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();
	if (!existing) throw new NotFoundError("Issue not found");

	// PROJ-311: gate the write on the effective project role (owner/admin bypass).
	// No grant → invisible → 404; a viewer grant is read-only → 403.
	if (!isWorkspaceAdmin(ctx.role)) {
		const projRole = await effectiveProjectRole(ctx, existing.projectId);
		if (projRole === null) throw new NotFoundError("Issue not found");
		if (!canWriteProject(projRole)) throw new ForbiddenError("Insufficient permissions");
	}

	const { setValues, recordCompletionReport } = await buildUpdateSetValues(
		ctx,
		orm,
		data,
		existing
	);

	await orm
		.update(schema.issues)
		.set(setValues)
		.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)));

	if (recordCompletionReport && data.completionReport) {
		await addComment(ctx, {
			issueId: id,
			body: formatCompletionReportComment(data.completionReport),
		});
	}

	await reindexIssueFts(ctx, orm, id, data);
	await applyCustomFieldUpdates(ctx, id, data);

	const diff = { ...buildUpdateDiffCore(data), ...buildUpdateDiffRefs(data) };
	await recordActivity(ctx, { entityType: "issue", entityId: id, action: "updated", diff });

	await invalidateUpdateCaches(ctx, id, data, existing);

	return { ok: true };
}

export async function deleteIssue(ctx: ServiceCtx, id: string) {
	const idCheck = IdSchema.safeParse(id);
	if (!idCheck.success)
		throw new ValidationError({ formErrors: idCheck.error.flatten().formErrors, fieldErrors: {} });
	const orm = drizzle(ctx.db, { schema });

	const existing = await orm
		.select({ parentId: schema.issues.parentId, projectId: schema.issues.projectId })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)))
		.get();

	// PROJ-311: deletion needs admin inside the project — workspace owner/admin bypass
	// groups; everyone else needs a project-admin grant.
	if (!isWorkspaceAdmin(ctx.role)) {
		const projRole = existing ? await effectiveProjectRole(ctx, existing.projectId) : null;
		if (projRole !== "admin") throw new ForbiddenError("Insufficient permissions");
	}

	await orm
		.delete(schema.issues)
		.where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, ctx.workspaceId)));
	await ctx.db
		.prepare("DELETE FROM issues_fts WHERE issue_id = ? AND workspace_id = ?")
		.bind(id, ctx.workspaceId)
		.run();
	await recordActivity(ctx, { entityType: "issue", entityId: id, action: "deleted" });
	await cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${id}`);

	if (existing?.parentId) {
		await cache.invalidate(ctx.kv, `issue:${ctx.workspaceId}:${existing.parentId}`);
	}

	return { ok: true };
}

const PRIORITY_SCORE: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

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
	const limit =
		typeof input.limit === "number" && input.limit > 0
			? Math.min(Math.floor(input.limit), 100)
			: 10;
	const includeBacklog = input.includeBacklog !== false;
	const excludeClaimed = input.excludeClaimed === true;
	const includeNotReady = input.includeNotReady === true;
	const projectId =
		typeof input.projectId === "string" && input.projectId ? input.projectId : undefined;
	return { limit, includeBacklog, excludeClaimed, includeNotReady, projectId };
}

async function fetchOpenIssuesForPrioritization(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	includeBacklog: boolean,
	projectId: string | undefined
) {
	const visible = visibleProjectPredicate(ctx, schema.issues.projectId);
	return orm
		.select({
			id: schema.issues.id,
			title: schema.issues.title,
			status: schema.issues.status,
			priority: schema.issues.priority,
			project_id: schema.issues.projectId,
			number: schema.issues.number,
			status_id: schema.issues.statusId,
			status_category: schema.taskStatuses.category,
			body: schema.issues.body,
		})
		.from(schema.issues)
		.leftJoin(schema.taskStatuses, eq(schema.issues.statusId, schema.taskStatuses.id))
		.where(
			and(
				eq(schema.issues.workspaceId, ctx.workspaceId),
				// PROJ-311: only prioritize issues in projects the user can see.
				...(visible ? [visible as Condition] : []),
				...(projectId ? [eq(schema.issues.projectId, projectId)] : []),
				or(
					and(
						isNull(schema.issues.statusId),
						sql`${schema.issues.status} NOT IN ('done', 'cancelled')`
					),
					and(
						isNotNull(schema.issues.statusId),
						sql`${schema.taskStatuses.category} NOT IN ('done', 'cancelled')`
					)
				),
				...(!includeBacklog ? [sql`${schema.issues.status} != 'backlog'`] : [])
			)
		);
}

type OpenIssue = Awaited<ReturnType<typeof fetchOpenIssuesForPrioritization>>[number];

async function computeInDegree(
	orm: ReturnType<typeof drizzle>,
	ctx: ServiceCtx,
	issueIds: string[]
): Promise<Record<string, number>> {
	// inChunks: issueIds is every open issue, so this would otherwise blow past D1's
	// 100-bound-parameter cap on any reasonably busy workspace. See services/sql.ts.
	const links = await inChunks(issueIds, (chunk) =>
		orm
			.select({ target_issue_id: schema.issueLinks.targetIssueId })
			.from(schema.issueLinks)
			.where(
				and(
					eq(schema.issueLinks.workspaceId, ctx.workspaceId),
					inArray(schema.issueLinks.targetIssueId, chunk)
				)
			)
	);

	const inDegree: Record<string, number> = {};
	for (const link of links) {
		inDegree[link.target_issue_id] = (inDegree[link.target_issue_id] ?? 0) + 1;
	}
	return inDegree;
}

async function computeStoryPoints(
	orm: ReturnType<typeof drizzle>,
	issueIds: string[]
): Promise<Record<string, number>> {
	const cfValues = await inChunks(issueIds, (chunk) =>
		orm
			.select({
				issue_id: schema.customFieldValues.issueId,
				sp: sql<number>`CAST(${schema.customFieldValues.value} AS REAL)`,
			})
			.from(schema.customFieldValues)
			.innerJoin(
				schema.customFieldDefinitions,
				eq(schema.customFieldValues.fieldId, schema.customFieldDefinitions.id)
			)
			.where(
				and(
					inArray(schema.customFieldValues.issueId, chunk),
					or(
						like(schema.customFieldDefinitions.key, "%story%"),
						like(schema.customFieldDefinitions.key, "%point%"),
						like(schema.customFieldDefinitions.label, "%story%"),
						like(schema.customFieldDefinitions.label, "%point%")
					)
				)
			)
	);

	const storyPoints: Record<string, number> = {};
	for (const cf of cfValues) {
		if (cf.sp > 0) storyPoints[cf.issue_id] = cf.sp;
	}
	return storyPoints;
}

function scoreOpenIssues(
	openIssues: readonly OpenIssue[],
	inDegree: Record<string, number>,
	storyPoints: Record<string, number>
) {
	const issueIds = openIssues.map((i) => i.id);
	const maxInDegree = Math.max(...issueIds.map((id) => inDegree[id] ?? 0), 1);

	const scored = openIssues.map((issue) => {
		const centrality = (inDegree[issue.id] ?? 0) / maxInDegree;
		const priority = (PRIORITY_SCORE[issue.priority] ?? 0) / 4;
		const sp = storyPoints[issue.id] ?? 1;
		const composite = 0.4 * centrality + 0.4 * priority + 0.2 * (1 / sp);
		return {
			...issue,
			_score: composite,
			_score_breakdown: { centrality, priority, story_points: sp },
		};
	});

	scored.sort((a, b) => b._score - a._score);
	return scored;
}

export async function getPrioritizedIssues(ctx: ServiceCtx, raw: unknown) {
	const { limit, includeBacklog, excludeClaimed, includeNotReady, projectId } =
		parsePrioritizedFilters(raw);

	const orm = drizzle(ctx.db, { schema });

	const issues = await fetchOpenIssuesForPrioritization(orm, ctx, includeBacklog, projectId);
	if (issues.length === 0) return { issues: [] };

	// excludeClaimed (PROJ-184): drop issues held by a live lease so "what should
	// I work on next?" skips tickets another agent is already on.
	const openIssues = excludeClaimed
		? await (async () => {
				const leased = await liveLeasedIssueIds(ctx);
				return issues.filter((i) => !leased.has(i.id));
			})()
		: issues;

	if (openIssues.length === 0) return { issues: [] };

	const issueIds = openIssues.map((i) => i.id);
	const inDegree = await computeInDegree(orm, ctx, issueIds);
	const storyPoints = await computeStoryPoints(orm, issueIds);

	const scored = scoreOpenIssues(openIssues, inDegree, storyPoints);

	// PROJ-253: definition-of-ready gate. By default, issues missing acceptance
	// criteria/scope/verification are dropped from "what should I work on next?" — an
	// agent that claims one is set up to guess. includeNotReady surfaces them anyway,
	// annotated with what's missing, for grooming.
	const annotated = scored.map(({ body, ...issue }) => {
		const { ready, missing } = checkDefinitionOfReady(body ?? "");
		return ready ? issue : { ...issue, needsGrooming: true, missingCriteria: missing };
	});
	// PROJ-291: don't SILENTLY drop not-ready issues — a caller seeing an empty list
	// otherwise concludes "no work" when a differently-worded backlog exists. Surface
	// the count so the caller knows to groom (or re-query with includeNotReady).
	const droppedNotReady = annotated.filter((i) => "needsGrooming" in i).length;
	const ready = includeNotReady ? annotated : annotated.filter((i) => !("needsGrooming" in i));

	return { issues: ready.slice(0, limit), droppedNotReady: includeNotReady ? 0 : droppedNotReady };
}

export async function searchIssues(ctx: ServiceCtx, raw: unknown) {
	const result = SearchIssuesInputSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { query, projectId, limit } = result.data;

	const ftsQuery = sanitizeFtsQuery(query);
	if (!ftsQuery) return [];

	let q = `SELECT i.id, i.number, i.title, i.status, i.priority,
              p.id as project_id, p.key as project_key, p.name as project_name
           FROM issues_fts
           JOIN issues i ON i.id = issues_fts.issue_id
           LEFT JOIN projects p ON p.id = i.project_id
           WHERE issues_fts MATCH ? AND issues_fts.workspace_id = ?`;
	const params: unknown[] = [ftsQuery, ctx.workspaceId];

	if (projectId) {
		q += " AND i.project_id = ?";
		params.push(projectId);
	}

	// PROJ-311: restrict full-text results to the user's visible projects.
	const visible = visibleProjectSqlFragment(ctx, "i.project_id");
	if (visible) {
		q += ` AND ${visible.sql}`;
		params.push(...visible.params);
	}

	q += " ORDER BY bm25(issues_fts) LIMIT ?";
	params.push(limit);

	const { results } = await ctx.db
		.prepare(q)
		.bind(...params)
		.all();
	return results;
}
