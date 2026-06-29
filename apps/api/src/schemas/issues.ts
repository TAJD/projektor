import { z } from "zod";
import { PriorityEnum, StatusEnum, TaxonomyIdSchema } from "./common";

export const CreateIssueSchema = z.object({
	projectId: z.string().uuid(),
	title: z.string().min(1).max(500),
	body: z.string().max(50000).optional(),
	status: StatusEnum.optional(),
	statusId: TaxonomyIdSchema.nullable().optional(),
	priority: PriorityEnum.optional(),
	assigneeId: z.string().uuid().optional(),
	labels: z.array(z.string().max(50)).max(20).optional(),
	parentId: z.string().uuid().nullable().optional(),
	typeId: TaxonomyIdSchema.nullable().optional(),
	customFields: z.record(z.string(), z.unknown()).optional(),
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
		parentId: z.string().uuid().nullable().optional(),
		typeId: TaxonomyIdSchema.nullable().optional(),
		customFields: z.record(z.string(), z.unknown()).optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const ListIssuesSchema = z.object({
	status: StatusEnum.optional(),
	statusId: TaxonomyIdSchema.optional(),
	statusIds: z.string().optional(),
	category: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
	priority: PriorityEnum.optional(),
	priorities: z.string().optional(),
	projectId: z.string().optional(),
	assignee: z.string().optional(),
	parentId: z.string().uuid().optional(),
	noParent: z.coerce.boolean().optional(),
	typeId: TaxonomyIdSchema.optional(),
	excludeTypeIds: z.string().optional(),
	sprintId: z.string().uuid().optional(),
	cfKey: z.string().optional(),
	cfOp: z.enum(["eq", "gt", "gte", "lt", "lte"]).optional(),
	cfValue: z.string().optional(),
	cursor: z.coerce.number().optional(),
	limit: z.coerce.number().min(1).max(100).default(30),
});

export const GetIssueSchema = z
	.object({
		id: z.string().optional(),
		ref: z.string().optional(),
	})
	.refine((obj) => obj.id || obj.ref, { message: "Provide either id or ref" });

export const SearchIssuesInputSchema = z.object({
	query: z.string().min(1),
	projectId: z.string().uuid().optional(),
	limit: z.number().int().min(1).max(50).optional().default(20),
});

export const LinkTypeInputEnum = z.enum(["blocks", "blocked_by", "relates_to", "duplicates"]);
export const LinkTypeStoredEnum = z.enum(["blocks", "relates_to", "duplicates"]);

export const CreateIssueLinkSchema = z.object({
	sourceIssueId: z.string().uuid(),
	targetIssueId: z.string().uuid(),
	type: LinkTypeInputEnum,
});

export const DeleteIssueLinkSchema = z.object({
	id: z.string().uuid(),
});

export const ListIssueLinksSchema = z.object({
	issueId: z.string().uuid(),
});
