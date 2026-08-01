import {
	ConflictError,
	NotFoundError,
	ServiceError,
	ValidationError,
	type ZodFlattenOutput,
} from "../services/errors";

const MAX_DETAIL_VALUE_CHARS = 80;
const MAX_DETAIL_SUMMARY_CHARS = 300;

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Not every MCP host surfaces the JSON-RPC 2.0 `error.data` member to the calling
// model — many render only `code`/`message`. `data` stays the primary, complete
// machine-readable channel, but a bounded human-readable summary is folded into
// `message` too so an agent without `data` access isn't left blind to *why* a
// structured error (conflict diff, ambiguous headings, ...) happened.
function summarizeDetails(details: Record<string, unknown>): string {
	const summary = Object.entries(details)
		.map(([key, value]) => {
			const rendered = Array.isArray(value)
				? value.join(", ")
				: typeof value === "string"
					? value
					: JSON.stringify(value);
			return `${key}: ${truncate(rendered, MAX_DETAIL_VALUE_CHARS)}`;
		})
		.join("; ");
	return truncate(summary, MAX_DETAIL_SUMMARY_CHARS);
}

function hasDetails(
	details: Record<string, unknown> | undefined
): details is Record<string, unknown> {
	return details !== undefined && Object.keys(details).length > 0;
}

// Same bounded-summary treatment as NotFoundError/ConflictError's `details`, but for
// ValidationError's Zod-flattened `issues` shape (formErrors + fieldErrors) instead of
// a flat details object.
function summarizeIssues(issues: ZodFlattenOutput): string {
	const parts: string[] = [
		...(issues.formErrors.length > 0
			? [truncate(issues.formErrors.join(", "), MAX_DETAIL_VALUE_CHARS)]
			: []),
		...Object.entries(issues.fieldErrors)
			.filter(([, messages]) => messages && messages.length > 0)
			.map(
				([field, messages]) => `${field}: ${truncate(messages.join(", "), MAX_DETAIL_VALUE_CHARS)}`
			),
	];
	return truncate(parts.join("; "), MAX_DETAIL_SUMMARY_CHARS);
}

function hasIssues(issues: ZodFlattenOutput): boolean {
	return (
		issues.formErrors.length > 0 ||
		Object.values(issues.fieldErrors).some((messages) => messages && messages.length > 0)
	);
}

export function toMcpError(err: unknown): { code: number; message: string; data?: unknown } {
	if (err instanceof ValidationError) {
		// PROJ-508/PROJ-523: surface the Zod issue detail (formErrors/fieldErrors) via
		// the JSON-RPC 2.0 `error.data` member instead of dropping it. This covers
		// ordinary schema-validation failures and hand-thrown ValidationErrors alike
		// (e.g. patch_wiki_page's ambiguous-heading case), so an MCP agent can always
		// read back *why* its params were rejected, not just that they were. A bounded
		// summary is also folded into `message` — same fallback as NotFoundError/
		// ConflictError below — for MCP hosts that don't surface `data`.
		if (hasIssues(err.issues)) {
			return {
				code: -32602,
				message: `Invalid params (${summarizeIssues(err.issues)})`,
				data: err.issues,
			};
		}
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
				// rather than JSON-encoded into `message`. A bounded summary is also folded
				// into `message` as a fallback for MCP hosts that don't surface `data`.
				if (err instanceof NotFoundError && hasDetails(err.details)) {
					return {
						code: -32000,
						message: `${err.message} (${summarizeDetails(err.details)})`,
						data: err.details,
					};
				}
				return { code: -32000, message: err.message };
			case "forbidden":
				return { code: -32000, message: err.message };
			case "conflict":
				// PROJ-484 / PROJ-508: a structured conflict (e.g. wiki's currentRevisionId +
				// diff) now travels in `data` instead of being JSON-encoded into `message`.
				// A bounded summary is also folded into `message` as a fallback for MCP
				// hosts that don't surface `data`.
				if (err instanceof ConflictError && hasDetails(err.details)) {
					return {
						code: -32000,
						message: `${err.message} (${summarizeDetails(err.details)})`,
						data: err.details,
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
