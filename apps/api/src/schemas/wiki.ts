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

// PROJ-488 (R6): the optional YAML frontmatter block parsed out of a page's `content`
// (services/wiki-frontmatter.ts). `.strict()` — an unrecognized key (a typo like
// `stauts:`) is a validation error rather than a silently-ignored no-op, matching the
// ticket's "invalid frontmatter -> structured error, never silently ignored or dropped".
// `type`/`status` are enforced as closed enums here (not the freeform text the DB column
// allows) per the ticket's explicit acceptance criteria — see the PR description for the
// design-decision writeup against the PRD's softer "freeform" language for `type`.
export const WikiFrontmatterSchema = z
	.object({
		type: z.enum(["runbook", "adr", "spec", "note"]).optional(),
		tags: z.array(z.string().min(1).max(50)).max(50).optional(),
		status: z.enum(["draft", "current", "stale", "deprecated"]).optional(),
		// Normalized to unix seconds by services/wiki-frontmatter.ts before this schema
		// runs (YAML dates parse to JS Date instances; ISO strings are also accepted).
		verified_at: z.number().int().nonnegative().nullable().optional(),
		verified_by: z.string().min(1).max(200).optional(),
		owners: z.array(z.string().min(1).max(200)).max(50).optional(),
		// Days between required re-verifications (R7/PROJ-489 consumes this; R6 only
		// stores it). Capped at 10 years to catch an obviously-wrong unit (e.g. seconds).
		verify_interval: z.number().int().positive().max(3650).optional(),
	})
	.strict();

export type WikiFrontmatterInput = z.infer<typeof WikiFrontmatterSchema>;

// PROJ-488: comma-separated (`?tags=a,b`) over REST query strings, or a plain array
// when called via MCP (JSON body) — both normalize to the same string[].
const TagsFilterSchema = z.preprocess((v) => {
	if (typeof v === "string") {
		return v
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	return v;
}, z.array(z.string()).max(50).optional());

const WikiTypeFilterSchema = z.enum(["runbook", "adr", "spec", "note"]).optional();
const WikiStatusFilterSchema = z.enum(["draft", "current", "stale", "deprecated"]).optional();

export const ListPagesInputSchema = z.object({
	parentId: z.string().optional(),
	projectId: z.string().uuid().optional(),
	// PROJ-488: any-of match — a page matches if it carries at least one of the given tags.
	tags: TagsFilterSchema,
	type: WikiTypeFilterSchema,
	status: WikiStatusFilterSchema,
});

export const SearchWikiInputSchema = z.object({
	query: z.string(),
	limit: z.coerce.number().int().min(1).max(50).optional().default(10),
	offset: z.coerce.number().int().min(0).optional().default(0),
	projectId: z.string().uuid().optional(),
	// Unix seconds — only pages updated at/after this time are returned.
	updatedSince: z.coerce.number().int().nonnegative().optional(),
	// PROJ-488: type/tags/status are now implemented filters (denormalized wiki_pages
	// columns, joined against the FTS match) — see services/wiki.ts#searchWiki.
	type: WikiTypeFilterSchema,
	tags: TagsFilterSchema,
	status: WikiStatusFilterSchema,
});

export const DeleteWikiPageOptionsSchema = z.object({
	// Default (false): children are promoted to the deleted page's parent. true: the
	// deleted page's entire subtree is removed too.
	cascade: z.boolean().optional().default(false),
});

// PROJ-485: broken-link reporting, optionally scoped to a project.
export const ListBrokenWikiLinksInputSchema = z.object({
	projectId: z.string().uuid().optional(),
});
