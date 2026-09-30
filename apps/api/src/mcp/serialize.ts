import { z } from "zod";
import { ValidationError } from "../services/errors";

// PROJ-891 (builds on PROJ-931): MCP-only response shaping. Applied in the MCP layer, not
// the service, so REST keeps returning the full shape — the service is the single source
// of truth for the data, this is presentation for the token-metered MCP surface.
// Conventions: apps/docs/src/content/docs/agents/response-conventions.md.

export const RESPONSE_CONVENTIONS_DOC = "/projektor/agents/response-conventions/";

/** Every tool description that shapes results says this, so a caller sees the contract. */
export const OMISSION_NOTE =
	"Omitted keys are null/empty/false; pass verbose:true for the raw shape. " +
	`See ${RESPONSE_CONVENTIONS_DOC}.`;

/** Per-result size ceiling (characters of serialized JSON). */
export const MAX_RESULT_CHARS = 20_000;

// Every key any issue-returning tool can emit (get_issue's full shape ∪ list items ∪ the
// derived `ref`/`type`/`updated`). `fields` is checked against this so a typo is a
// validation error, not a silent `null`.
export const ISSUE_FIELD_NAMES = [
	"ref",
	"type",
	"updated",
	"id",
	"workspace_id",
	"project_id",
	"number",
	"title",
	"body",
	"status",
	"priority",
	"assignee_id",
	"assignee_name",
	"labels",
	"parent_id",
	"type_id",
	"status_id",
	"status_category",
	"sprint_id",
	"created_by_id",
	"author_kind",
	"created_at",
	"updated_at",
	"completed_at",
	"needs_audit",
	"project_key",
	"project_name",
	"type_key",
	"type_name",
	"status_key",
	"status_name",
	"rollup",
	"links",
	"customFields",
	"url",
] as const;

export const VIEW_FIELDS_PROPS = {
	view: {
		type: "string",
		enum: ["summary", "full"],
		description:
			"summary = {ref,title,status,priority,type,parent?,assignee?,updated} per issue; " +
			"full (default) = every non-empty field. See " +
			RESPONSE_CONVENTIONS_DOC,
	},
	verbose: {
		type: "boolean",
		description: "Include normally-omitted empty/default/internal fields (default false)",
	},
	fields: {
		type: ["array", "string"],
		items: { type: "string" },
		description:
			"Return only these fields (array, or comma-separated string), with their real values " +
			"(null if the issue has no such value). Every named field is always present. Unknown " +
			`names are rejected. See ${RESPONSE_CONVENTIONS_DOC}`,
	},
} as const;

const ShapeOptsSchema = z.object({
	view: z.enum(["summary", "full"]).optional(),
	verbose: z.boolean().optional(),
	fields: z
		.union([z.string(), z.array(z.string())])
		.transform((v) =>
			(typeof v === "string" ? v.split(",") : v).map((s) => s.trim()).filter((s) => s.length > 0)
		)
		.pipe(z.array(z.enum(ISSUE_FIELD_NAMES)).max(ISSUE_FIELD_NAMES.length))
		.optional(),
});

export type ShapeOpts = z.infer<typeof ShapeOptsSchema>;

/**
 * Pulls the MCP-only view/verbose/fields options out of the raw tool input before it
 * reaches the (`.strict()`) service schema, validating them first.
 */
export function splitShapeOpts(input: unknown): { rest: Record<string, unknown> } & ShapeOpts {
	const { view, verbose, fields, ...rest } = (input ?? {}) as Record<string, unknown>;
	const result = ShapeOptsSchema.safeParse({ view, verbose, fields });
	if (!result.success) throw new ValidationError(result.error.flatten());
	return { rest, ...result.data };
}

function isEmptyArray(v: unknown): boolean {
	return Array.isArray(v) && v.length === 0;
}

function parseLabels(v: unknown): string[] | undefined {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (typeof v !== "string") return undefined;
	try {
		const parsed = JSON.parse(v);
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === "string")
			: undefined;
	} catch {
		return undefined;
	}
}

function isZeroRollup(v: unknown): boolean {
	return !!v && typeof v === "object" && (v as { total?: unknown }).total === 0;
}

// Dropped when null/unset: a caller checks the id, and the key/name pair only exists to
// save a lookup, so it is noise once the id is gone.
const NULLABLE_DEFAULT_KEYS = [
	"sprint_id",
	"parent_id",
	"completed_at",
	"author_kind",
	"status_category",
] as const;

// Internal ids a caller never needs: the workspace is the URL, the project is in `ref`,
// type/status are named by `type`/`status`, and the author is in `author_kind`.
const INTERNAL_ID_KEYS = [
	"workspace_id",
	"project_id",
	"type_id",
	"status_id",
	"created_by_id",
] as const;

// Name/key duplicates of things kept elsewhere: `ref` carries project_key + number,
// `type` carries type_key, and `status` carries the state.
const DUPLICATE_KEYS = [
	"project_key",
	"project_name",
	"type_key",
	"type_name",
	"status_key",
	"status_name",
] as const;

/** `PROJ-42` from a raw issue row, or undefined when the project key isn't joined in. */
function refOf(issue: Record<string, unknown>): string | undefined {
	return typeof issue.project_key === "string" && typeof issue.number === "number"
		? `${issue.project_key}-${issue.number}`
		: undefined;
}

/** The summary view: enough to triage and to address the issue again. */
function summarize(issue: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const ref = refOf(issue);
	if (ref) out.ref = ref;
	else if (issue.id != null) out.id = issue.id;
	out.title = issue.title;
	out.status = issue.status;
	out.priority = issue.priority;
	if (issue.type_key != null) out.type = issue.type_key;
	// Until refs are available on parents (PROJ-890) this is the parent's id.
	if (issue.parent_id != null) out.parent = issue.parent_id;
	const assignee = issue.assignee_name ?? issue.assignee_id;
	if (assignee != null) out.assignee = assignee;
	out.updated = issue.updated_at;
	return out;
}

/**
 * One serializer for every issue the MCP surface returns.
 *
 * - `fields`: an allowlist. Every named key is present with its real value (null only when
 *   the issue has no such value) so `fields:["assignee_id"]` never returns `{}`.
 * - `verbose`: the raw service shape, untouched.
 * - `view:"summary"`: the compact triage shape.
 * - otherwise (`full`, the default): drops null/empty/false defaults and internal ids,
 *   parses `labels` to an array, and adds `ref` and `type`.
 */
export function shapeIssue(
	issue: Record<string, unknown>,
	opts: ShapeOpts = {}
): Record<string, unknown> {
	const ref = refOf(issue);
	if (opts.fields && opts.fields.length > 0) {
		const source: Record<string, unknown> = {
			...issue,
			ref,
			type: issue.type_key,
			updated: issue.updated_at,
		};
		const picked: Record<string, unknown> = {};
		for (const f of opts.fields) picked[f] = Object.hasOwn(source, f) ? (source[f] ?? null) : null;
		return picked;
	}
	if (opts.verbose) return issue;
	if (opts.view === "summary") return summarize(issue);

	const out: Record<string, unknown> = { ...issue };
	if (ref) out.ref = ref;
	if (issue.type_key != null) out.type = issue.type_key;
	const labels = parseLabels(out.labels);
	if (labels && labels.length > 0) out.labels = labels;
	else delete out.labels;
	if (isEmptyArray(out.links)) delete out.links;
	if (isZeroRollup(out.rollup)) delete out.rollup;
	if (isEmptyArray(out.customFields)) delete out.customFields;
	if (out.assignee_id == null) {
		delete out.assignee_id;
		delete out.assignee_name;
	}
	if (out.needs_audit === false || out.needs_audit === 0) delete out.needs_audit;
	for (const key of NULLABLE_DEFAULT_KEYS) if (out[key] == null || out[key] === "") delete out[key];
	for (const key of INTERNAL_ID_KEYS) delete out[key];
	for (const key of DUPLICATE_KEYS) delete out[key];
	return out;
}

/** `{items, next?}` — the one list shape. `next` is omitted when there is no further page. */
export function toPage<T>(
	items: T[],
	next?: string | number | null,
	extra: Record<string, unknown> = {}
): { items: T[]; next?: string } & Record<string, unknown> {
	return { items, ...(next == null ? {} : { next: String(next) }), ...extra };
}

/**
 * Keeps a `{items, ...}` result under `max` serialized chars by dropping trailing items,
 * so the JSON is never cut mid-document. `truncated:true` marks that it happened.
 *
 * `cursorOf(i)` returns the cursor that resumes after item `i`; when a tool has no such
 * cursor the result carries a `hint` to lower `limit` or narrow the filters instead, and
 * any pre-existing `next` is dropped (it would skip the items that were cut).
 */
export function capPage<P extends { items: unknown[]; next?: string }>(
	page: P,
	opts: { max?: number; cursorOf?: (index: number) => string | undefined } = {}
): P & { truncated?: true; hint?: string } {
	const max = opts.max ?? MAX_RESULT_CHARS;
	if (JSON.stringify(page).length <= max) return page;

	const build = (k: number) => {
		const { next: _drop, ...rest } = page;
		const cursor = opts.cursorOf?.(k - 1);
		return {
			...rest,
			items: page.items.slice(0, k),
			truncated: true as const,
			...(cursor ? { next: cursor } : {}),
			...(opts.cursorOf
				? {}
				: { hint: `Result capped at ${max} chars; lower limit or narrow the filters.` }),
		} as P & { truncated: true; hint?: string };
	};

	let lo = 1;
	let hi = page.items.length;
	// Largest k (≥1) whose serialized form fits; one oversized item is still returned whole.
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (JSON.stringify(build(mid)).length <= max) lo = mid;
		else hi = mid - 1;
	}
	return build(lo);
}
