import type { MCPTool } from "@projektor/types";
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
} from "../services/issues";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./annotations";
import {
	capPage,
	OMISSION_NOTE,
	shapeIssue,
	splitShapeOpts,
	toPage,
	VIEW_FIELDS_PROPS,
} from "./serialize";
import { bodyPreview, ISSUE_BODY_MAX_CHARS, LIST_BODY_MAX_CHARS, windowText } from "./windowing";

const BODY_CHARS_PROP = {
	bodyChars: {
		type: "number",
		default: 0,
		description:
			`Include the first N characters of each item's body (0-${LIST_BODY_MAX_CHARS}, default 0 = ` +
			"no body); a cut body carries `bodyTruncated:true`. Read the rest with get_issue. " +
			"`includeBody:true` still returns whole bodies.",
	},
} as const;

/** Splits MCP-only `bodyChars` off the input; asks the service for bodies when it's set. */
function splitBodyChars(rest: Record<string, unknown>): {
	rest: Record<string, unknown>;
	bodyChars: number;
} {
	const { bodyChars, ...others } = rest;
	if (bodyChars === undefined) return { rest: others, bodyChars: 0 };
	if (
		!Number.isInteger(bodyChars) ||
		(bodyChars as number) < 0 ||
		(bodyChars as number) > LIST_BODY_MAX_CHARS
	) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: { bodyChars: [`must be an integer from 0 to ${LIST_BODY_MAX_CHARS}`] },
		});
	}
	const n = bodyChars as number;
	return { rest: n > 0 ? { ...others, includeBody: true } : others, bodyChars: n };
}

function withBodyPreview(
	item: Record<string, unknown>,
	bodyChars: number
): Record<string, unknown> {
	if (bodyChars <= 0) return item;
	return { ...item, ...bodyPreview(item.body, bodyChars) };
}

export const issuesTools: MCPTool[] = [
	{
		name: "list_issues",
		description:
			"List issues in the workspace, optionally filtered by status, priority, project, or assignee. " +
			"Items omit `body` by default — pass bodyChars:N (max 1000) for a preview, or includeBody:true for whole bodies. Pass includeRollups:true " +
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
				labels: {
					type: "array",
					items: { type: "string" },
					description:
						"Only issues carrying these labels (exact match, case-sensitive; max 20). All of them " +
						'by default — set labelsMode:"any" for at least one. Paginates like any other filter.',
				},
				labelsMode: {
					type: "string",
					enum: ["all", "any"],
					default: "all",
					description: "How `labels` combine: all (default) or any",
				},
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
					description: "Pagination cursor: pass the previous page's `next` unchanged",
				},
				limit: { type: "number", default: 50, description: "Max 100" },
				...BODY_CHARS_PROP,
				...VIEW_FIELDS_PROPS,
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { rest: shapeRest, ...shape } = splitShapeOpts(input);
			const { rest, bodyChars } = splitBodyChars(shapeRest);
			const result = (await listIssues(ctx, rest)) as {
				items: Record<string, unknown>[];
				nextCursor: string | null;
				total?: number;
			};
			// The cursor is derived from the raw rows so a capped page can resume exactly
			// after its last kept item (PROJ-857's (created_at,id) compound cursor).
			const raw = result.items;
			const page = toPage(
				raw.map((i) => shapeIssue(withBodyPreview(i, bodyChars), shape)),
				result.nextCursor,
				result.total === undefined ? {} : { total: result.total }
			);
			return capPage(page, {
				cursorOf: (i) => (raw[i] ? `${raw[i].created_at}:${raw[i].id}` : undefined),
			});
		},
	},
	{
		name: "get_issue",
		description:
			`Get a single issue by ID or project key + number (e.g. "PROJ-42"). \`body\` is returned ` +
			`up to ${ISSUE_BODY_MAX_CHARS} chars; if it is longer the result has \`bodyTruncated:true\`, ` +
			`\`bodyTotalChars\` and \`next\` — pass \`next\` back as \`cursor\` for the rest. ${OMISSION_NOTE}`,
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				ref: { type: "string", description: "Project key and number, e.g. PROJ-42" },
				cursor: {
					type: "string",
					description: "Continue a long body: pass the previous result's `next` unchanged",
				},
				...VIEW_FIELDS_PROPS,
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { rest: shapeRest, ...shape } = splitShapeOpts(input);
			const { cursor, ...rest } = shapeRest as { cursor?: string } & Record<string, unknown>;
			const issue = (await getIssue(ctx, rest)) as Record<string, unknown>;
			const shaped = shapeIssue(issue, shape);
			if (typeof shaped.body !== "string") return shaped;
			// PROJ-892: a long body is windowed; \`next\` continues it.
			const w = windowText(shaped.body, { max: ISSUE_BODY_MAX_CHARS, cursor });
			if (!w.next && cursor === undefined) return shaped;
			return {
				...shaped,
				body: w.text,
				bodyTotalChars: w.totalChars,
				...(w.next ? { bodyTruncated: true, next: w.next } : {}),
			};
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
				...BODY_CHARS_PROP,
				...VIEW_FIELDS_PROPS,
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const { rest: shapeRest, ...shape } = splitShapeOpts(input);
			const { rest, bodyChars } = splitBodyChars(shapeRest);
			const result = (await getIssuesBatch(ctx, rest)) as {
				items: Record<string, unknown>[];
				missing: string[];
			};
			return {
				items: result.items.map((i) => shapeIssue(withBodyPreview(i, bodyChars), shape)),
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
			"CI run/PR/commit link), the issue is flagged needsAudit:true for after-the-fact human review. " +
			"If the work is only partly done, pass completionReport.remainder when marking done: a follow-up " +
			"issue (same parent and labels, linked follows_from) is created and its ref returned as followUp.ref.",
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
						remainder: {
							type: "string",
							description:
								"What is NOT done. When the issue is marked done, a follow-up issue is created " +
								"under the same parent with the same labels, linked follows_from this one; its " +
								"ref is returned as followUp.ref",
						},
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
		name: "search_issues",
		description:
			"Search issues by keyword in title or body, or by exact label text (an issue whose label " +
			"equals the whole query is a hit, listed first; case-insensitive for ASCII only). Pass `labels` to narrow keyword hits to " +
			"issues carrying those labels. To list every issue with a label — with pagination — use " +
			"list_issues with `labels` instead; search returns at most 50.",
		inputSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: { type: "string", minLength: 1 },
				projectId: {
					type: "string",
					description: "Restrict search to a specific project — UUID or project key like PROJ",
				},
				labels: {
					type: "array",
					items: { type: "string" },
					description:
						"Only issues carrying these labels (exact match, case-sensitive; max 20). All of them " +
						'by default — set labelsMode:"any" for at least one.',
				},
				labelsMode: {
					type: "string",
					enum: ["all", "any"],
					default: "all",
					description: "How `labels` combine: all (default) or any",
				},
				limit: { type: "number", default: 20, description: "Max 50" },
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			return toPage((await searchIssues(ctx, input)) as unknown[]);
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
