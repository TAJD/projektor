import type { MCPTool } from "@projektor/types";
import {
	createLinkAttachment,
	deleteAttachment,
	getAttachmentMetadata,
	listAttachments,
} from "../services/files";
import type { ServiceCtx } from "../services/types";

// Binary upload and streamed download can't cross JSON-RPC, so those two operations
// stay REST-only (POST /api/files, GET /api/files/:id) — a deliberate parity exception
// (AGENTS.md). Everything else (list, metadata, link-create, delete) is metadata-only
// and gets full MCP parity here (PROJ-234).
export const filesTools: MCPTool[] = [
	{
		name: "list_attachments",
		description: "List attachments (files, wiki-page links, URLs) on an issue or wiki page",
		inputSchema: {
			type: "object",
			required: ["entityType", "entityId"],
			properties: {
				entityType: { type: "string", enum: ["issue", "wiki_page"] },
				entityId: { type: "string" },
			},
		},
		async handler(input, ctx) {
			return listAttachments(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "get_attachment",
		description:
			"Get attachment metadata by id. For kind 'file' the bytes themselves are only " +
			"available over REST (GET /api/files/:id) — binary content can't cross JSON-RPC.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		async handler(input, ctx) {
			return getAttachmentMetadata(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "create_link_attachment",
		description: "Attach a wiki-page reference or an external URL to an issue or wiki page",
		inputSchema: {
			type: "object",
			required: ["kind", "entityType", "entityId"],
			properties: {
				kind: { type: "string", enum: ["wiki_ref", "url"] },
				entityType: { type: "string", enum: ["issue", "wiki_page"] },
				entityId: { type: "string" },
				wikiPageId: { type: "string", description: "Required when kind is 'wiki_ref'" },
				url: { type: "string", description: "Required when kind is 'url'" },
				label: { type: "string", description: "Optional display label when kind is 'url'" },
			},
		},
		async handler(input, ctx) {
			return createLinkAttachment(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "delete_attachment",
		description: "Delete an attachment by id",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: { id: { type: "string" } },
		},
		async handler(input, ctx) {
			const serviceCtx = ctx as unknown as ServiceCtx;
			const { r2Key } = await deleteAttachment(serviceCtx, input);
			// R2 object I/O is streaming-specific in the REST route; do the equivalent
			// cleanup here so the MCP path doesn't leave the blob orphaned in storage.
			if (r2Key) await serviceCtx.r2.delete(r2Key);
			return { ok: true };
		},
	},
];
