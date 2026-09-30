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
				([field, messages]) =>
					`${field}: ${truncate(messages?.join(", ") ?? "", MAX_DETAIL_VALUE_CHARS)}`
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

// PROJ-508/PROJ-523: surface the Zod issue detail (formErrors/fieldErrors) via the
// JSON-RPC 2.0 `error.data` member instead of dropping it. This covers ordinary
// schema-validation failures and hand-thrown ValidationErrors alike (e.g.
// patch_wiki_page's ambiguous-heading case), so an MCP agent can always read back
// *why* its params were rejected, not just that they were. A bounded summary is also
// folded into `message` — same fallback as NotFoundError/ConflictError below — for MCP
// hosts that don't surface `data`.
function toMcpValidationError(err: ValidationError): {
	code: number;
	message: string;
	data?: unknown;
} {
	if (!hasIssues(err.issues)) {
		return { code: -32602, message: "Invalid params", data: err.issues };
	}
	return {
		code: -32602,
		message: `Invalid params (${summarizeIssues(err.issues)})`,
		data: err.issues,
	};
}

// PROJ-490 / PROJ-508 / PROJ-484: structured details (e.g. patch_wiki_page's
// currentHeadings, or wiki's currentRevisionId + diff) travel in `data` — the proper
// JSON-RPC 2.0 channel — rather than JSON-encoded into `message`. A bounded summary is
// also folded into `message` as a fallback for MCP hosts that don't surface `data`.
function toMcpServiceErrorWithDetails(
	message: string,
	details: Record<string, unknown> | undefined
): { code: number; message: string; data?: unknown } {
	if (!hasDetails(details)) return { code: -32000, message };
	return { code: -32000, message: `${message} (${summarizeDetails(details)})`, data: details };
}

export function toMcpError(
	err: unknown,
	requestId: string
): { code: number; message: string; data?: unknown } {
	if (err instanceof ValidationError) return toMcpValidationError(err);
	if (err instanceof ServiceError) {
		// Only the kinds whose messages are deliberately client-facing are
		// surfaced (audited 2026-06-30: not_found / forbidden / conflict messages
		// are controlled domain strings — "Issue not found", "Slug already taken",
		// or the caller's own key echoed back — never internals). Any other
		// ServiceError kind is treated as internal so a future subclass can't
		// leak its message to clients by default. (PROJ-204)
		switch (err.kind) {
			case "not_found":
				return toMcpServiceErrorWithDetails(
					err.message,
					err instanceof NotFoundError ? err.details : undefined
				);
			case "forbidden":
				return { code: -32000, message: err.message };
			case "conflict":
				return toMcpServiceErrorWithDetails(
					err.message,
					err instanceof ConflictError ? err.details : undefined
				);
			default:
				console.error(`[mcp] unhandled ServiceError kind (request ${requestId}):`, err.kind, err);
				return {
					code: -32000,
					message: `Internal error (request: ${requestId})`,
					data: { requestId },
				};
		}
	}
	console.error(`[mcp] unhandled error in tools/call (request ${requestId}):`, err);
	return { code: -32000, message: `Internal error (request: ${requestId})`, data: { requestId } };
}

// ---------------------------------------------------------------------------
// PROJ-893: tool execution failures are tool *results* (`isError: true`), not JSON-RPC
// protocol errors. The MCP spec puts them there so the model sees the failure and can
// self-correct; a client only MAY show a protocol error to the model. JSON-RPC errors
// (toMcpError above) stay reserved for protocol faults — parse error, invalid request,
// method not found, unknown tool — and for an unexpected internal failure, whose
// message must never carry anything but a request id.
//
// The code set is the kinds services already throw (services/errors.ts: PROJ-878's
// not_found / forbidden / conflict / validation / payload_too_large) plus rate_limited,
// which the request-limiter work (PROJ-899) will produce. Scope denials are neither: they
// stay an HTTP 403 with a WWW-Authenticate challenge (PROJ-651), handled in routes/mcp.ts.
// ---------------------------------------------------------------------------

export type ToolErrorCode =
	| "not_found"
	| "forbidden"
	| "conflict"
	| "validation"
	| "payload_too_large"
	| "rate_limited";

export type ToolErrorBody = {
	code: ToolErrorCode;
	message: string;
	/** Per-field problems, for `validation`. */
	fields?: Record<string, string[]>;
	/** A concrete next step the model can take. */
	hint?: string;
	/** Structured extras a service attached (a wiki conflict diff, the current headings, …). */
	details?: Record<string, unknown>;
};

export type ToolErrorResult = {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
};

export type ToolErrorContext = {
	/** The tool that was called — hints name the tool that would have found the thing. */
	toolName?: string;
	/** The caller's effective role, so a `forbidden` hint can say what is missing. */
	role?: string;
};

export function toolErrorResult(error: ToolErrorBody): ToolErrorResult {
	return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
}

function definedFields(
	fieldErrors: ZodFlattenOutput["fieldErrors"]
): Record<string, string[]> | undefined {
	const out: Record<string, string[]> = {};
	for (const [field, messages] of Object.entries(fieldErrors)) {
		if (messages && messages.length > 0) out[field] = messages;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function notFoundHint(message: string, toolName: string | undefined): string {
	const subject = `${message} ${toolName ?? ""}`.toLowerCase();
	if (subject.includes("wiki") || subject.includes("page")) {
		return "Wiki pages are addressed by slug. Use search_wiki or wiki_tree to find one.";
	}
	if (subject.includes("issue")) {
		return "Refs look like PROJ-42 (project key + number). Use search_issues to find one.";
	}
	if (subject.includes("project")) {
		return "Projects are addressed by UUID or key (e.g. PROJ). Use list_projects to see them.";
	}
	if (subject.includes("agent session")) {
		return "Sessions come from register_agent; an ended session no longer exists to call.";
	}
	return "Check the id or ref. Use the matching search_ or list_ tool to look it up.";
}

function conflictHint(message: string, details: Record<string, unknown> | undefined): string {
	if (details && "currentRevisionId" in details) {
		return "The page changed since you read it. Re-read it with get_wiki_page, then apply your change with patch_wiki_page.";
	}
	if (/wip limit/i.test(message)) {
		return "Finish or release one of the issues listed as currently held, then claim again.";
	}
	return "Someone else's change got there first. Re-read the current state and retry.";
}

/**
 * The tool-result form of a failed tools/call, or null when the failure is not one the
 * model can act on (an unexpected internal error — the caller keeps the JSON-RPC
 * "Internal error (request: …)" for those, which never leaks internals).
 */
export function toToolError(err: unknown, ctx: ToolErrorContext = {}): ToolErrorResult | null {
	if (err instanceof ValidationError) {
		const fields = definedFields(err.issues.fieldErrors);
		const message =
			err.issues.formErrors.length > 0 ? err.issues.formErrors.join("; ") : "Invalid arguments";
		return toolErrorResult({
			code: "validation",
			message,
			...(fields ? { fields } : {}),
			...(fields ? { hint: `Fix ${Object.keys(fields).join(", ")} and retry.` } : {}),
		});
	}
	if (!(err instanceof ServiceError)) return null;

	switch (err.kind) {
		case "not_found": {
			const details = err instanceof NotFoundError ? err.details : undefined;
			return toolErrorResult({
				code: "not_found",
				message: err.message,
				hint: notFoundHint(err.message, ctx.toolName),
				...(hasDetails(details) ? { details } : {}),
			});
		}
		case "forbidden":
			return toolErrorResult({
				code: "forbidden",
				message: err.message,
				hint: ctx.role
					? `Your role here is ${ctx.role}; this needs a higher one (members write, admins and owners manage).`
					: "Your role does not allow this; members write, admins and owners manage.",
			});
		case "conflict": {
			const details = err instanceof ConflictError ? err.details : undefined;
			return toolErrorResult({
				code: "conflict",
				message: err.message,
				hint: conflictHint(err.message, details),
				...(hasDetails(details) ? { details } : {}),
			});
		}
		case "payload_too_large":
			return toolErrorResult({
				code: "payload_too_large",
				message: err.message,
				hint: "Send less data, or split it across several calls.",
			});
		default:
			return null;
	}
}
