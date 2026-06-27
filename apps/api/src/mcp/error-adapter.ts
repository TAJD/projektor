import { ServiceError, ValidationError } from "../services/errors";

export function toMcpError(err: unknown): { code: number; message: string } {
	if (err instanceof ValidationError) {
		return { code: -32602, message: "Invalid params" };
	}
	if (err instanceof ServiceError) {
		return { code: -32000, message: err.message };
	}
	console.error("[mcp] unhandled error in tools/call:", err);
	return { code: -32000, message: "Internal error" };
}
