import type { MCPTool } from "@projektor/types";
import { z } from "zod";
import { ValidationError } from "../services/errors";
import {
	createIssue,
	deleteIssue,
	getIssue,
	getIssuesBatch,
	getPrioritizedIssues,
	listIssues,
	searchIssues,
	updateIssue,
	updateIssues,
} from "../services/issues";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./annotations";

// PROJ-931: MCP-only response shaping. Applied here (not in the service) so REST keeps
// returning the full shape unconditionally — the service is the single source of truth
// for the data, this is presentation for the token-metered MCP surface only.
// PROJ-931 review: every compacting tool's description must say this verbatim so a
// caller reading only the tool description (not the source) knows the contract.
const OMISSION_NOTE = "Omitted keys are null/empty/false; pass verbose:true for the full shape.";

const VERBOSE_FIELDS_PROPS = {
	verbose: {
		type: "boolean",
		description: "Include normally-omitted empty/default fields (default false)",
	},
	fields: {
		type: "array",
		items: { type: "string" },
		description:
			"Return only these fields per issue, with their real values (null if the issue " +
			"has no such value). Every named field is always present. Unknown names are rejected.",
	},
} as const;

function isEmptyArray(v: unknown): boolean {
	return Array.isArray(v) && v.length === 0;
}

function isEmptyLabels(v: unknown): boolean {
	if (typeof v !== "string") return false;
	try {
		const parsed = JSON.parse(v);
		return Array.isArray(parsed) && parsed.length === 0;
	} catch {
		return false;
	}
}

function isZeroRollup(v: unknown): boolean {
	return !!v && typeof v === "object" && (v as { total?: unknown }).total === 0;
}

// Keys dropped when they hold their null/unset default. Each has a same-named "_id"
// (or is one) that a caller checks for presence — the *_key/*_name pair only exists to
// avoid a client having to look the id up, so it's noise once the id itself is gone.
const NULLABLE_DEFAULT_KEYS = [
	"sprint_id",
	"parent_id",
	"type_id",
	"type_key",
	"type_name",
	"status_id",
	"status_key",
	"status_name",
	"completed_at",
	"author_kind",
] as const;

// Strips empty/default noise unless verbose:true, then applies an optional `fields`
// allowlist. Covers the fields named in PROJ-931's acceptance criteria (empty links,
// zero rollup, empty customFields, null sprint/assignee/parent, empty labels) plus the
// same "empty or default" treatment for the rest of the null/zero-value columns every
// issue carries (unset type/status/sprint, no completion, needs_audit's false default,
// author_kind for a human-authored issue) — omitting only the AC's four examples still
// left get_issue short of the ticket's 40% byte-reduction bar on a typical issue.
//
// `fields` always returns every requested key with its real value (null only when the
// issue has no such key/value) — a caller that asked for `fields: ["assignee_id"]` must
// never get back `{}` just because this issue happens to have no assignee.
function shapeIssue(
	issue: Record<string, unknown>,
	opts: { verbose?: boolean; fields?: string[] }
): Record<string, unknown> {
	if (opts.fields && opts.fields.length > 0) {
		// A requested field is always returned with its real value — `false`, `[]` or a
		// zero rollup stay as they are so the caller can tell them from "absent" (null).
		const picked: Record<string, unknown> = {};
		for (const f of opts.fields) {
			picked[f] = Object.hasOwn(issue, f) ? (issue[f] ?? null) : null;
		}
		return picked;
	}
	if (opts.verbose) return issue;

	const out = { ...issue };
	if (isEmptyArray(out.links)) delete out.links;
	if (isZeroRollup(out.rollup)) delete out.rollup;
	if (isEmptyArray(out.customFields)) delete out.customFields;
	if (out.assignee_id == null) {
		delete out.assignee_id;
		delete out.assignee_name;
	}
	if (isEmptyLabels(out.labels)) delete out.labels;
	if (out.status_category === "") delete out.status_category;
	if (out.needs_audit === false || out.needs_audit === 0) delete out.needs_audit;
	for (const key of NULLABLE_DEFAULT_KEYS) {
		if (out[key] == null) delete out[key];
	}
	return out;
}

// Validated separately from the (`.strict()`) service schemas, which know nothing about
// these MCP-only options — a wrong type here must still produce a JSON-RPC -32602
// (invalid params), not silently fall through or crash.
// Every key any issue-returning tool can emit (get_issue's full shape ∪ list items).
// `fields` is checked against this so a typo is a -32602, not a silent `null`.
export const ISSUE_FIELD_NAMES = [
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

const ShapeOptsSchema = z.object({
	verbose: z.boolean().optional(),
	fields: z.array(z.enum(ISSUE_FIELD_NAMES)).max(ISSUE_FIELD_NAMES.length).optional(),
});

// Pulls the MCP-only verbose/fields options out of the raw tool input before it reaches
// the service schema, validating them first.
function splitShapeOpts(input: unknown): {
	rest: Record<string, unknown>;
	verbose?: boolean;
	fields?: string[];
} {
	const { verbose, fields, ...rest } = (input ?? {}) as {
		verbose?: unknown;
		fields?: unknown;
		[k: string]: unknown;
	};
	const result = ShapeOptsSchema.safeParse({ verbose, fields });
	if (!result.success) throw new ValidationError(result.error.flatten());
	return { rest, verbose: result.data.verbose, fields: result.data.fields };
}

export const issuesTools: MCPTool[] = [
	{
		name: "list_issues",
		description:
			"List issues in the workspace, optionally filtered by status, priority, project, or assignee. " +
			"Items omit `body` by default — pass includeBody:true to include it. Pass includeRollups:true " +
			"to attach a `rollup` (child status counts: total/byStatus/done/remaining) to each item " +
			"(a zero rollup is omitted unless verbose:true). " +
			OMISSION_NOTE,
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "UUID of the project, or a project key like PROJ",
				},
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: { type: "string", description: "Filter by task status ID" },
				statusIds: {
					type: "string",
					description: "Comma-separated task status IDs (OR-matched)",
				},
				category: {
					type: "string",
					enum: ["todo", "in_progress", "done", "cancelled"],
					description: "Filter by status category",
				},
				priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
				priorities: {
					type: "string",
					description: "Comma-separated priorities (OR-matched), e.g. urgent,high",
				},
				assignee: {
					type: "string",
					description: 'Filter by assignee user ID, or "me" for the calling user',
				},
				parentId: {
					type: "string",
					description:
						"Filter by parent issue ID, or a ref like PROJ-42 (returns direct children only)",
				},
				noParent: {
					type: "boolean",
					description: "Only return issues with no parent (top-level issues)",
				},
				typeId: { type: "string", description: "Filter by task type ID" },
				excludeTypeIds: {
					type: "string",
					description: "Comma-separated task type IDs to exclude (e.g. the epic type)",
				},
				sprintId: { type: "string", description: "Filter by sprint ID" },
				cfKey: { type: "string", description: "Custom field key to filter by" },
				cfOp: {
					type: "string",
					enum: ["eq", "gt", "gte", "lt", "lte"],
					description: "Comparison operator for the custom field filter (requires cfKey)",
				},
				cfValue: {
					type: "string",
					description: "Value to compare the custom field against (requires cfKey)",
				},
				completedAfter: {
					type: "number",
					description: "Only issues marked completed at or after this epoch-seconds time",
				},
				completedBefore: {
					type: "number",
					description: "Only issues marked completed at or before this epoch-seconds time",
				},
				updatedAfter: {
					type: "number",
					description: "Only issues last edited at or after this epoch-seconds time",
				},
				updatedBefore: {
					type: "number",
					description: "Only issues last edited at or before this epoch-seconds time",
				},
				needsAudit: {
					type: "boolean",
					description:
						"Filter to agent-initiated done-closures flagged for human audit — true for " +
						"unverifiable evidence, false for externally-checkable evidence",
				},
				includeRollups: {
					type: "boolean",
					description:
						"Attach a `rollup` of child status counts (total/byStatus/done/remaining) to each returned item",
				},
				includeBody: {
					type: "boolean",
					description: "Include the `body` field on each item (omitted by default)",
				},
				cursor: {
					type: ["string", "integer"],
					description: "Pagination cursor: pass the previous page's `nextCursor` unchanged",
				},
				limit: { type: "number", default: 50, description: "Max 100" },
				...VERBOSE_FIELDS_PROPS,
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { rest, verbose, fields } = splitShapeOpts(input);
			const result = (await listIssues(ctx, rest)) as { items: Record<string, unknown>[] };
			return {
				...result,
				items: result.items.map((i) => shapeIssue(i, { verbose, fields })),
			};
		},
	},
	{
		name: "get_issue",
		description: `Get a single issue by ID or project key + number (e.g. "PROJ-42"). ${OMISSION_NOTE}`,
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				ref: { type: "string", description: "Project key and number, e.g. PROJ-42" },
				...VERBOSE_FIELDS_PROPS,
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { rest, verbose, fields } = splitShapeOpts(input);
			const issue = (await getIssue(ctx, rest)) as Record<string, unknown>;
			return shapeIssue(issue, { verbose, fields });
		},
	},
	{
		name: "get_issues",
		description:
			"Fetch up to 50 issues in one call, by ref (e.g. PROJ-42) and/or id. Cheaper than " +
			"repeated get_issue calls for triage. Items carry customFields but no rollup/links/" +
			"assignee_name, and omit `body` unless includeBody:true. Returned in the order refs/ids " +
			"were given; `missing` lists (once each) any requested ref/id that didn't resolve or " +
			"isn't visible to you. " +
			OMISSION_NOTE,
		inputSchema: {
			type: "object",
			properties: {
				refs: {
					type: "array",
					items: { type: "string" },
					description: "Refs like PROJ-42 (max 50 combined with ids)",
				},
				ids: {
					type: "array",
					items: { type: "string" },
					description: "Issue UUIDs (max 50 combined with refs)",
				},
				includeBody: {
					type: "boolean",
					description: "Include each issue's `body` (omitted by default)",
				},
				...VERBOSE_FIELDS_PROPS,
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { rest, verbose, fields } = splitShapeOpts(input);
			const result = (await getIssuesBatch(ctx, rest)) as {
				items: Record<string, unknown>[];
				missing: string[];
			};
			return {
				items: result.items.map((i) => shapeIssue(i, { verbose, fields })),
				missing: result.missing,
			};
		},
	},
	{
		name: "create_issue",
		description:
			"Create a new issue in a project. For an issue an agent should be able to pick up " +
			"autonomously, the body should state acceptance criteria and scope (files/components) " +
			"— see get_workflow's definition of ready. get_prioritized_issues excludes issues " +
			"missing these by default. Verification isn't part of the readiness bar (PROJ-738) — " +
			"it's required later, in the completionReport when entering review/done.",
		inputSchema: {
			type: "object",
			required: ["projectId", "title"],
			properties: {
				projectId: {
					type: "string",
					description: "UUID of the project, or a project key like PROJ",
				},
				title: { type: "string" },
				body: { type: "string" },
				priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: { type: "string", description: "UUID of the task status to assign" },
				assigneeId: { type: "string", description: "UUID of the user to assign" },
				labels: { type: "array", items: { type: "string" } },
				parentId: {
					type: "string",
					description: "UUID of the parent issue, or a ref like PROJ-42 (optional; max depth 5)",
				},
				typeId: { type: "string", description: "UUID of the task type to assign" },
			},
		},
		annotations: CREATE,
		handler(input, ctx) {
			return createIssue(ctx, input);
		},
	},
	{
		name: "update_issue",
		description:
			"Update an issue — status, priority, title, body, assignee, or labels. Review gating: " +
			"pass agentSessionId to identify yourself as an agent; entering in_review as " +
			"an agent requires completionReport. Agents CAN transition directly to done (no human " +
			"approval gate) — but if the completionReport.verification isn't externally checkable (no " +
			"CI run/PR/commit link), the issue is flagged needsAudit:true for after-the-fact human review.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "UUID of the issue, or a ref like PROJ-42" },
				title: { type: "string" },
				body: { type: "string" },
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: {
					type: "string",
					nullable: true,
					description: "UUID of the task status (null to clear)",
				},
				priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
				assigneeId: { type: "string", nullable: true },
				labels: { type: "array", items: { type: "string" } },
				parentId: {
					type: "string",
					nullable: true,
					description: "Set or clear the parent issue — UUID or ref like PROJ-42 (null to remove)",
				},
				typeId: { type: "string", nullable: true },
				agentSessionId: {
					type: "string",
					description:
						"Your agent session id (from register_agent) — identifies this update as agent-initiated",
				},
				completionReport: {
					type: "object",
					description:
						"Required when an agent moves an issue into in_review; also gates the done transition",
					properties: {
						summary: { type: "string" },
						verification: { type: "string" },
						prLink: { type: "string" },
					},
				},
			},
		},
		annotations: IDEMPOTENT_WRITE,
		handler(input, ctx) {
			const { id, ...fields } = input as { id?: string; [k: string]: unknown };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return updateIssue(ctx, id, fields);
		},
	},
	{
		name: "update_issues",
		description:
			"Apply one status transition to up to 100 issues at once (e.g. closing every ticket in a " +
			"release with one shared completion report), instead of one update_issue call per issue. " +
			"Records the shared completionReport (PR/release links) once per issue; pass perIssue to " +
			"override just the summary for specific issues. Same review gating and needsAudit " +
			"classification as update_issue, applied to each issue individually — one issue failing " +
			"(missing ref, forbidden, invalid transition, missing report) never aborts the others. " +
			"Returns a per-issue result in request order, each under the id/ref you passed in `ids`.",
		inputSchema: {
			type: "object",
			required: ["ids"],
			properties: {
				ids: {
					type: "array",
					items: { type: "string" },
					description: "1-100 issue UUIDs and/or refs like PROJ-42",
				},
				status: {
					type: "string",
					enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
				},
				statusId: {
					type: "string",
					nullable: true,
					description: "UUID of the task status (null to clear)",
				},
				completionReport: {
					type: "object",
					description:
						"Shared completion report applied to every issue (required for an agent closing " +
						"an agent-worked issue, same rule as update_issue)",
					properties: {
						summary: { type: "string" },
						verification: { type: "string" },
						prLink: { type: "string" },
					},
				},
				perIssue: {
					type: "object",
					description:
						"Per-issue override, keyed by the same id/ref used in `ids`. Only `summary` can be " +
						"overridden; verification/prLink always come from the shared completionReport.",
					additionalProperties: {
						type: "object",
						properties: { summary: { type: "string" } },
					},
				},
				agentSessionId: {
					type: "string",
					description:
						"Your agent session id (from register_agent) — identifies this update as agent-initiated",
				},
			},
		},
		annotations: IDEMPOTENT_WRITE,
		handler(input, ctx) {
			return updateIssues(ctx, input);
		},
	},
	{
		name: "search_issues",
		description: "Search issues by keyword in title or body",
		inputSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: { type: "string", minLength: 1 },
				projectId: {
					type: "string",
					description: "Restrict search to a specific project — UUID or project key like PROJ",
				},
				limit: { type: "number", default: 20, description: "Max 50" },
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return searchIssues(ctx, input);
		},
	},
	{
		name: "delete_issue",
		description: "Delete an issue by ID or ref (e.g. PROJ-42)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string", description: "UUID of the issue, or a ref like PROJ-42" },
			},
		},
		annotations: DESTRUCTIVE,
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return deleteIssue(ctx, id);
		},
	},
	{
		name: "get_prioritized_issues",
		description:
			"Return open issues ranked by a composite score: link-network centrality (in-degree) + priority + " +
			"inverse story points. Useful for deciding what to work on next. By default, issues that fail the " +
			"definition-of-ready check (missing acceptance criteria or scope/files) are excluded. " +
			"If none of the open issues pass, the ranked (not-ready) list is returned anyway with " +
			"`degraded: true` on the response and `needsGrooming`/`missingCriteria` on each issue, rather than " +
			'an empty array — empty otherwise means "no open work", which would be a lie.',
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					default: 10,
					description: "Max issues to return (default 10, max 100)",
				},
				includeBacklog: {
					type: "boolean",
					default: true,
					description: "Include backlog-status issues (default true)",
				},
				excludeClaimed: {
					type: "boolean",
					default: false,
					description: "Skip issues currently held by a live lease (default false)",
				},
				includeNotReady: {
					type: "boolean",
					default: false,
					description:
						"Include issues that fail the definition-of-ready check, annotated with " +
						"needsGrooming and missingCriteria (default false)",
				},
				projectId: {
					type: "string",
					description:
						"Scope ranking to a single project's issues (default: workspace-wide, all visible projects)",
				},
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return getPrioritizedIssues(ctx, input);
		},
	},
];
