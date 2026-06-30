import { ServiceError, ValidationError } from "../services/errors";

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
			case "forbidden":
			case "conflict":
				return { code: -32000, message: err.message };
			default:
				console.error("[mcp] unhandled ServiceError kind in tools/call:", err.kind, err);
				return { code: -32000, message: "Internal error" };
		}
	}
	console.error("[mcp] unhandled error in tools/call:", err);
	return { code: -32000, message: "Internal error" };
}
