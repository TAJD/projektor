import { z } from "zod";
import { BooleanQueryParam, PriorityEnum, StatusEnum, TaxonomyIdSchema } from "./common";
import { CustomFieldFilterSchema } from "./custom-fields";

export const CreateIssueSchema = z
	.object({
		projectId: z.string(),
		title: z.string().min(1).max(500),
		body: z.string().max(50000).optional(),
		status: StatusEnum.optional(),
		statusId: TaxonomyIdSchema.nullable().optional(),
		priority: PriorityEnum.optional(),
		assigneeId: z.string().uuid().optional(),
		labels: z.array(z.string().max(50)).max(20).optional(),
		parentId: z.string().nullable().optional(),
		typeId: TaxonomyIdSchema.nullable().optional(),
		customFields: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

// PROJ-254: completion report an agent (or human) submits when entering review /
// before an issue can be marked done. Exported (PROJ-929) so finish_work's schema can
// reuse it rather than duplicating the shape.
export const CompletionReportSchema = z.object({
	summary: z.string().min(1),
	verification: z.string().min(1),
	prLink: z
		.string()
		.transform((val) => (z.string().url().safeParse(val).success ? val : undefined))
		.optional(),
});

export const UpdateIssueSchema = z
	.object({
		title: z.string().min(1).max(500).optional(),
		body: z.string().max(50000).optional(),
		status: StatusEnum.optional(),
		statusId: TaxonomyIdSchema.nullable().optional(),
		priority: PriorityEnum.optional(),
		assigneeId: z.string().uuid().nullable().optional(),
		labels: z.array(z.string().max(50)).max(20).optional(),
		parentId: z.string().nullable().optional(),
		typeId: TaxonomyIdSchema.nullable().optional(),
		customFields: z.record(z.string(), z.unknown()).optional(),
		agentSessionId: z.string().uuid().optional(),
		completionReport: CompletionReportSchema.optional(),
	})
	.strict()
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

// PROJ-930: bulk close/transition — one shared completionReport (PR/release links) applied
// to up to 100 issues in one call, with an optional per-issue summary override. `ids`
// accepts UUIDs or refs (PROJ-42), same as update_issue's id — each is resolved and gated
// individually by updateIssue itself, so this schema only validates the bulk envelope.
export const UpdateIssuesSchema = z
	.object({
		ids: z.array(z.string().min(1)).min(1).max(100),
		status: StatusEnum.optional(),
		statusId: TaxonomyIdSchema.nullable().optional(),
		completionReport: CompletionReportSchema.optional(),
		// Keyed by the literal string the caller used in `ids` (a UUID or a ref like
		// PROJ-42) — not the resolved id, since the caller may not know it.
		perIssue: z.record(z.string(), z.object({ summary: z.string().min(1) })).optional(),
		agentSessionId: z.string().uuid().optional(),
	})
	.strict()
	.refine((obj) => obj.status !== undefined || obj.statusId !== undefined, {
		message: "status or statusId is required",
	});

export const IssueListCursorSchema = z
	.union([z.number().int().nonnegative(), z.string().regex(/^\d+(?::[A-Za-z0-9-]+)?$/)])
	.transform((v) => {
		if (typeof v === "number") return { createdAt: v } as { createdAt: number; id?: string };
		const [createdAt, id] = v.split(":");
		return { createdAt: Number(createdAt), id } as { createdAt: number; id?: string };
	});

export const ListIssuesSchema = z
	.object({
		status: StatusEnum.optional(),
		statusId: TaxonomyIdSchema.optional(),
		statusIds: z.string().optional(),
		category: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
		priority: PriorityEnum.optional(),
		priorities: z.string().optional(),
		projectId: z.string().optional(),
		// PROJ-444: "me" is a sentinel the service resolves to ctx.userId — kept visible in
		// the schema (rather than folded silently into z.string()) so both surfaces document it.
		assignee: z.union([z.literal("me"), z.string()]).optional(),
		parentId: z.string().optional(),
		noParent: BooleanQueryParam.optional(),
		typeId: TaxonomyIdSchema.optional(),
		excludeTypeIds: z.string().optional(),
		sprintId: z.string().uuid().optional(),
		...CustomFieldFilterSchema.shape,
		// Date-range filters (PROJ-212), epoch seconds; inclusive bounds.
		completedAfter: z.coerce.number().optional(),
		completedBefore: z.coerce.number().optional(),
		updatedAfter: z.coerce.number().optional(),
		updatedBefore: z.coerce.number().optional(),
		// PROJ-375: surface agent-initiated done-closures whose evidence wasn't
		// externally checkable, for periodic human audit.
		needsAudit: BooleanQueryParam.optional(),
		// PROJ-441: compute child rollups for the returned page in one grouped query
		// (see computeChildRollupsForParents in services/issues.ts) instead of the
		// frontend fanning out a getIssue call per row.
		includeRollups: BooleanQueryParam.optional(),
		// PROJ-442: list items omit `body` by default (it's rarely needed and can be
		// large); set this to restore it.
		includeBody: BooleanQueryParam.optional(),
		// PROJ-857: `<created_at>:<id>` — created_at alone (1 s precision) skipped rows
		// created in the same second across a page boundary. A bare number (the old
		// format) is still accepted from clients holding a pre-upgrade cursor.
		cursor: IssueListCursorSchema.optional(),
		limit: z.coerce.number().min(1).max(100).default(30),
	})
	.strict();

export const GetIssueSchema = z
	.object({
		id: z.string().optional(),
		ref: z.string().optional(),
	})
	.strict()
	.refine((obj) => obj.id || obj.ref, { message: "Provide either id or ref" });

// PROJ-931: accepts either a real array (MCP JSON) or a comma-separated string
// (REST query param), same convention as the existing statusIds/excludeTypeIds filters.
const CommaOrArraySchema = z
	.union([z.string(), z.array(z.string())])
	.transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean));

export const GetIssuesBatchSchema = z
	.object({
		refs: CommaOrArraySchema.optional(),
		ids: CommaOrArraySchema.optional(),
		includeBody: BooleanQueryParam.optional(),
	})
	.strict()
	.refine((obj) => (obj.refs?.length ?? 0) + (obj.ids?.length ?? 0) > 0, {
		message: "Provide refs or ids",
	})
	.refine((obj) => (obj.refs?.length ?? 0) + (obj.ids?.length ?? 0) <= 50, {
		message: "At most 50 issues per call (refs + ids combined)",
	});

export const SearchIssuesInputSchema = z
	.object({
		query: z.string().min(1),
		projectId: z.string().optional(),
		limit: z.number().int().min(1).max(50).optional().default(20),
	})
	.strict();

export const LinkTypeInputEnum = z.enum(["blocks", "blocked_by", "relates_to", "duplicates"]);
export const LinkTypeStoredEnum = z.enum(["blocks", "relates_to", "duplicates"]);

export const CreateIssueLinkSchema = z
	.object({
		sourceIssueId: z.string(),
		targetIssueId: z.string(),
		type: LinkTypeInputEnum,
	})
	.strict();

export const DeleteIssueLinkSchema = z
	.object({
		id: z.string().uuid(),
	})
	.strict();

export const ListIssueLinksSchema = z
	.object({
		issueId: z.string(),
	})
	.strict();
