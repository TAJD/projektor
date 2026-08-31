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
// before an issue can be marked done.
const CompletionReportSchema = z.object({
	summary: z.string().min(1),
	verification: z.string().min(1),
	prLink: z.string().url().optional(),
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
		cursor: z.coerce.number().optional(),
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
