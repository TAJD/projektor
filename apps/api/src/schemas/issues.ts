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
export const CompletionReportSchema = z
	.object({
		summary: z.string().min(1),
		verification: z.string().min(1),
		prLink: z
			.string()
			.transform((val) => (z.string().url().safeParse(val).success ? val : undefined))
			.optional(),
		// PROJ-961: what is NOT done. When the issue is marked done, a follow-up issue
		// (same parent, same labels, linked follows_from) is created carrying this text.
		remainder: z.preprocess(
			(v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
			z.string().trim().min(1).max(20000).optional()
		),
	})
	.strict();

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

export const IssueListCursorSchema = z
	.union([z.number().int().nonnegative(), z.string().regex(/^\d+(?::[A-Za-z0-9-]+)?$/)])
	.transform((v) => {
		if (typeof v === "number") return { createdAt: v } as { createdAt: number; id?: string };
		const [createdAt, id] = v.split(":");
		return { createdAt: Number(createdAt), id } as { createdAt: number; id?: string };
	});

// PROJ-931: accepts either a real array (MCP JSON) or a comma-separated string
// (REST query param), same convention as the existing statusIds/excludeTypeIds filters.
const CommaOrArraySchema = z
	.union([z.string(), z.array(z.string())])
	.transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean));

// PROJ-960: label filter shared by list_issues and search_issues. Labels are matched exactly
// (case-sensitive, the way they're stored). Same bounds as the labels a create/update accepts.
const LabelFilterSchema = CommaOrArraySchema.pipe(z.array(z.string().max(50)).max(20));
const LabelsModeSchema = z.enum(["all", "any"]);

export const ListIssuesSchema = z
	.object({
		status: StatusEnum.optional(),
		statusId: TaxonomyIdSchema.optional(),
		statusIds: z.string().optional(),
		category: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
		open: BooleanQueryParam.optional(),
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
		// PROJ-960: all-of by default (every label must be present); labelsMode:"any" matches
		// issues carrying at least one. An empty list is no filter.
		labels: LabelFilterSchema.optional(),
		labelsMode: LabelsModeSchema.optional(),
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
		// PROJ-960: narrow the keyword hits to issues carrying these labels (see ListIssuesSchema).
		labels: LabelFilterSchema.optional(),
		labelsMode: LabelsModeSchema.optional(),
		limit: z.number().int().min(1).max(50).optional().default(20),
	})
	.strict();

export const LinkTypeInputEnum = z.enum([
	"blocks",
	"blocked_by",
	"relates_to",
	"duplicates",
	"follows_from",
]);
export const LinkTypeStoredEnum = z.enum(["blocks", "relates_to", "duplicates", "follows_from"]);
// PROJ-961: what list_issue_links reports from the viewing issue's side; "followed_by" is the
// inverse of follows_from and is output-only.
export const LinkTypeEffectiveEnum = z.enum([
	"blocks",
	"blocked_by",
	"relates_to",
	"duplicates",
	"follows_from",
	"followed_by",
]);

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
