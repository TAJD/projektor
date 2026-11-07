import { z } from "zod";
import {
	DeleteAttachmentSchema,
	EntityTypeSchema,
	GetAttachmentSchema,
	ListAttachmentsSchema,
} from "../schemas/files";
import {
	createLinkAttachment,
	deleteAttachment,
	getAttachment,
	listAttachments,
} from "../services/files";
import { defineOperation } from "./define";

const base = {
	domain: "files",
	keywords: ["attachment", "upload", "file", "link", "url", "document"],
};

const entityId = z.string().min(1).meta({
	description: "Issue UUID or ref like PROJ-42 (when entityType is issue), or wiki page id",
});

export const fileOperations = [
	defineOperation({
		...base,
		id: "list_attachments",
		method: "GET",
		path: "/api/files",
		tier: "read",
		summary: "List attachments (files, wiki-page links, URLs) on an issue or wiki page",
		input: ListAttachmentsSchema.extend({ entityId }),
		run: (ctx, input) => listAttachments(ctx, input),
	}),
	defineOperation({
		...base,
		id: "get_attachment",
		method: "GET",
		path: "/api/files/:id/metadata",
		tier: "read",
		summary:
			"Get attachment metadata by id. For kind 'file' the bytes themselves are only " +
			"available over REST (GET /api/files/:id) — binary content can't cross JSON-RPC.",
		input: GetAttachmentSchema,
		run: (ctx, input) => getAttachment(ctx, input),
	}),
	defineOperation({
		...base,
		id: "create_link_attachment",
		method: "POST",
		path: "/api/files/links",
		tier: "write",
		status: 201,
		summary: "Attach a wiki-page reference or an external URL to an issue or wiki page",
		input: z.object({
			kind: z.enum(["wiki_ref", "url"]),
			entityType: EntityTypeSchema,
			entityId,
			wikiPageId: z.string().optional().meta({ description: "Required when kind is 'wiki_ref'" }),
			url: z.string().optional().meta({ description: "Required when kind is 'url'" }),
			label: z
				.string()
				.optional()
				.meta({ description: "Optional display label when kind is 'url'" }),
		}),
		run: (ctx, input) => createLinkAttachment(ctx, input),
	}),
	defineOperation({
		...base,
		id: "delete_attachment",
		method: "DELETE",
		path: "/api/files/:id",
		tier: "destructive",
		status: 204,
		summary: "Delete an attachment by id",
		input: DeleteAttachmentSchema,
		run: async (ctx, input) => {
			const { r2Key } = await deleteAttachment(ctx, input);
			if (r2Key) await ctx.r2.delete(r2Key);
			return { ok: true };
		},
	}),
];
