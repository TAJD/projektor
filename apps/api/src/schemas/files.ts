import { z } from "zod";

// cofferdam-ignore: Design.OrphanExport: exported for schema-module consistency, used only within this file today
export const EntityTypeSchema = z.enum(["issue", "wiki_page"]);

export const ListAttachmentsSchema = z.object({
	entityType: EntityTypeSchema,
	entityId: z.string().min(1),
});

export const CreateLinkAttachmentSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("wiki_ref"),
		entityType: EntityTypeSchema,
		entityId: z.string().min(1),
		wikiPageId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("url"),
		entityType: EntityTypeSchema,
		entityId: z.string().min(1),
		url: z
			.string()
			.url()
			.refine((u) => /^https?:\/\//i.test(u), "URL must be http or https"),
		label: z.string().trim().max(200).optional(),
	}),
]);

export const RecordFileUploadSchema = z.object({
	entityType: EntityTypeSchema,
	entityId: z.string().min(1),
	filename: z.string().min(1),
	contentType: z.string(),
	size: z.number().int().nonnegative(),
	r2Key: z.string().min(1),
});

export const GetAttachmentSchema = z.object({ id: z.string().min(1) });

export const DeleteAttachmentSchema = z.object({ id: z.string().min(1) });
