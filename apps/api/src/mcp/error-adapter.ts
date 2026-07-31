import { ConflictError, NotFoundError, ServiceError, ValidationError } from "../services/errors";

export function toMcpError(err: unknown): { code: number; message: string } {
	if (err instanceof ValidationError) {
		return { code: -32602, message: "Invalid params" };
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
				// PROJ-490: mirrors the conflict case below — structured not-found details
				// (e.g. patch_wiki_page's currentHeadings) are JSON-encoded into the
				// message for callers that set `details`; plain not-found errors keep a
				// plain string.
				if (err instanceof NotFoundError && err.details) {
					return {
						code: -32000,
						message: JSON.stringify({ message: err.message, ...err.details }),
					};
				}
				return { code: -32000, message: err.message };
			case "forbidden":
				return { code: -32000, message: err.message };
			case "conflict":
				// PROJ-484: JSON-RPC errors here only carry {code, message} (routes/mcp.ts
				// builds the response and isn't touched by this ticket), so a structured
				// conflict (e.g. wiki's currentRevisionId + diff) is JSON-encoded into the
				// message for callers that set `details`; plain conflicts keep a plain string.
				if (err instanceof ConflictError && err.details) {
					return {
						code: -32000,
						message: JSON.stringify({ message: err.message, ...err.details }),
					};
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
