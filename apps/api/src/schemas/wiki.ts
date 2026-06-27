import { z } from "zod";

export const CreatePageSchema = z.object({
	title: z.string().min(1).max(300),
	content: z.string().max(500000).optional(),
	parentId: z.string().uuid().optional(),
	projectId: z.string().uuid().optional(),
	slug: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-z0-9-/]+$/)
		.optional(),
});

export const UpdatePageSchema = z
	.object({
		title: z.string().min(1).max(300).optional(),
		content: z.string().max(500000).optional(),
		parentId: z.string().uuid().nullable().optional(),
	})
	.refine((d) => d.title !== undefined || d.content !== undefined || d.parentId !== undefined, {
		message: "At least one of title, content, or parentId must be provided",
	});

export const ListPagesInputSchema = z.object({
	parentId: z.string().optional(),
	projectId: z.string().uuid().optional(),
});

export const SearchWikiInputSchema = z.object({
	query: z.string(),
	limit: z.number().int().min(1).max(50).optional().default(10),
	projectId: z.string().uuid().optional(),
});
