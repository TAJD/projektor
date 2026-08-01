import { ConflictError, NotFoundError, ServiceError, ValidationError } from "../services/errors";

export function toMcpError(err: unknown): { code: number; message: string; data?: unknown } {
	if (err instanceof ValidationError) {
		// PROJ-508/PROJ-523: surface the Zod issue detail (formErrors/fieldErrors) via
		// the JSON-RPC 2.0 `error.data` member instead of dropping it. This covers
		// ordinary schema-validation failures and hand-thrown ValidationErrors alike
		// (e.g. patch_wiki_page's ambiguous-heading case), so an MCP agent can always
		// read back *why* its params were rejected, not just that they were.
		return { code: -32602, message: "Invalid params", data: err.issues };
	}
	if (err instanceof ServiceError) {
		// Only the kinds whose messages are deliberately client-facing are
		// surfaced (audited 2026-06-30: not_found / forbidden / conflict messages
		// are controlled domain strings — "Issue not found", "Slug already taken",
		// or the caller's own key echoed back — never internals). Any other
		// ServiceError kind is treated as internal so a future subclass can't
		// leak its message to clients by default. (PROJ-204)
		switch (err.kind) {
			case "not_found":
				// PROJ-490 / PROJ-508: structured not-found details (e.g. patch_wiki_page's
				// currentHeadings) now travel in `data` — the proper JSON-RPC 2.0 channel —
				// rather than JSON-encoded into `message`.
				if (err instanceof NotFoundError && err.details) {
					return { code: -32000, message: err.message, data: err.details };
				}
				return { code: -32000, message: err.message };
			case "forbidden":
				return { code: -32000, message: err.message };
			case "conflict":
				// PROJ-484 / PROJ-508: a structured conflict (e.g. wiki's currentRevisionId +
				// diff) now travels in `data` instead of being JSON-encoded into `message`.
				if (err instanceof ConflictError && err.details) {
					return { code: -32000, message: err.message, data: err.details };
				}
				return { code: -32000, message: err.message };
			default:
				console.error("[mcp] unhandled ServiceError kind in tools/call:", err.kind, err);
				return { code: -32000, message: "Internal error" };
		}
	}
	console.error("[mcp] unhandled error in tools/call:", err);
	return { code: -32000, message: "Internal error" };
}
