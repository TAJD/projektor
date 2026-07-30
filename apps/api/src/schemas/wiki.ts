import { z } from "zod";

const SlugSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-z0-9-/]+$/);

export const CreatePageSchema = z.object({
	title: z.string().min(1).max(300),
	content: z.string().max(500000).optional(),
	parentId: z.string().uuid().optional(),
	projectId: z.string().uuid().optional(),
	slug: SlugSchema.optional(),
});

export const UpdatePageSchema = z
	.object({
		title: z.string().min(1).max(300).optional(),
		content: z.string().max(500000).optional(),
		parentId: z.string().uuid().nullable().optional(),
		// PROJ-483: renaming a page's slug leaves a wiki_redirects entry for the old
		// slug so existing links/bookmarks keep resolving (services/wiki.ts).
		slug: SlugSchema.optional(),
		// PROJ-484: optimistic locking. Omitted → today's last-write-wins behavior
		// (deprecated, transitional). Provided → must match the page's current latest
		// revision id, or the write is rejected with a structured conflict. `null` means
		// "I read this page before it had ever been revised" (services/wiki.ts).
		baseRevisionId: z.string().nullable().optional(),
		// PROJ-484: optional edit message/changelog note, stored on the revision
		// created for this write (only recorded when `content` changes).
		summary: z.string().max(2000).optional(),
	})
	.refine(
		(d) =>
			d.title !== undefined ||
			d.content !== undefined ||
			d.parentId !== undefined ||
			d.slug !== undefined,
		{
			message: "At least one of title, content, parentId, or slug must be provided",
		}
	);

export const ListPagesInputSchema = z.object({
	parentId: z.string().optional(),
	projectId: z.string().uuid().optional(),
});

export const SearchWikiInputSchema = z.object({
	query: z.string(),
	limit: z.number().int().min(1).max(50).optional().default(10),
	projectId: z.string().uuid().optional(),
});

export const DeleteWikiPageOptionsSchema = z.object({
	// Default (false): children are promoted to the deleted page's parent. true: the
	// deleted page's entire subtree is removed too.
	cascade: z.boolean().optional().default(false),
});
