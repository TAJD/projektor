import { z } from "zod";
import {
	capPage,
	OMISSION_NOTE,
	ShapeOptsSchema,
	shapeIssue,
	splitShapeOpts,
	toPage,
	VIEW_FIELDS_PROPS,
} from "../mcp/serialize";
import {
	bodyPreview,
	ISSUE_BODY_MAX_CHARS,
	LIST_BODY_MAX_CHARS,
	windowText,
} from "../mcp/windowing";
import {
	CreateIssueSchema,
	GetIssuesBatchSchema,
	IssueListCursorInput,
	ListIssuesSchema,
	SearchIssuesInputSchema,
	UpdateIssueSchema,
} from "../schemas/issues";
import {
	createIssue,
	deleteIssue,
	getIssue,
	getIssuesBatch,
	getPrioritizedIssues,
	ISSUE_REF_PATTERN,
	listIssues,
	searchIssues,
	updateIssue,
} from "../services/issues";
import { defineOperation } from "./define";

const base = {
	domain: "issues",
	keywords: ["issue", "ticket", "task", "bug", "story", "epic", "backlog", "work item"],
};

function d<T extends z.ZodType>(field: T, description: string): T {
	return field.meta({ description }) as T;
}

const Shape = {
	view: d(ShapeOptsSchema.shape.view, VIEW_FIELDS_PROPS.view.description),
	verbose: d(ShapeOptsSchema.shape.verbose, VIEW_FIELDS_PROPS.verbose.description),
	fields: d(ShapeOptsSchema.shape.fields, VIEW_FIELDS_PROPS.fields.description),
};

const BodyChars = d(
	z.number().int().min(0).max(LIST_BODY_MAX_CHARS).optional(),
	`Include the first N characters of each item's body (0-${LIST_BODY_MAX_CHARS}, default 0 = ` +
		"no body); a cut body carries `bodyTruncated:true`. Read the rest with get_issue. " +
		"`includeBody:true` still returns whole bodies."
);

const flag = (description: string) => d(z.boolean().optional(), description);

const IssueIdOrRef = d(z.string().min(1), "UUID of the issue, or a ref like PROJ-42");

const ProjectIdOrKey = d(z.string().optional(), "UUID of the project, or a project key like PROJ");

const LabelsFilter = (paging: string) =>
	d(
		ListIssuesSchema.shape.labels,
		"Only issues carrying these labels (exact match, case-sensitive; max 20). All of them " +
			`by default — set labelsMode:"any" for at least one.${paging}`
	);

const LabelsMode = d(
	ListIssuesSchema.shape.labelsMode,
	"How `labels` combine: all (default) or any"
);

type Shaping = { view?: unknown; verbose?: unknown; fields?: unknown; bodyChars?: number };

function serviceInput<T extends Shaping>(input: T) {
	const { view: _v, verbose: _vb, fields: _f, bodyChars, ...rest } = input;
	return bodyChars ? { ...rest, includeBody: true } : rest;
}

function withBodyPreview(item: Record<string, unknown>, bodyChars = 0) {
	return bodyChars > 0 ? { ...item, ...bodyPreview(item.body, bodyChars) } : item;
}

type PrioritizedRaw = {
	id: string;
	title: string;
	status: string;
	priority: string;
	project_key: string | null;
	number: number;
	_score: number;
	needsGrooming?: true;
	missingCriteria?: string[];
};

function shapePrioritized(r: PrioritizedRaw): Record<string, unknown> {
	return {
		...(r.project_key ? { ref: `${r.project_key}-${r.number}` } : { id: r.id }),
		title: r.title,
		status: r.status,
		priority: r.priority,
		score: Math.round(r._score * 1000) / 1000,
		...(r.needsGrooming ? { needsGrooming: true, missingCriteria: r.missingCriteria } : {}),
	};
}

export const issueOperations = [
	defineOperation({
		...base,
		id: "list_issues",
		method: "GET",
		path: "/api/issues",
		tier: "read",
		restAliases: { project: "projectId" },
		mcpDefaults: { bodyChars: 0 },
		summary:
			"List issues in the workspace, optionally filtered by status, priority, project, or assignee. " +
			"Items omit `body` by default — pass bodyChars:N (max 1000) for a preview, or includeBody:true for whole bodies. Pass includeRollups:true " +
			"to attach a `rollup` (child status counts: total/byStatus/done/remaining) to each item " +
			"(a zero rollup is omitted unless verbose:true). " +
			OMISSION_NOTE,
		input: ListIssuesSchema.extend({
			projectId: ProjectIdOrKey,
			statusId: d(ListIssuesSchema.shape.statusId, "Filter by task status ID"),
			statusIds: d(
				ListIssuesSchema.shape.statusIds,
				"Comma-separated task status IDs (OR-matched)"
			),
			category: d(
				ListIssuesSchema.shape.category,
				"Filter by a single status category (use `open` for todo + in_progress)"
			),
			open: flag(
				"Only issues that are neither done nor cancelled. Cannot be combined with category. Items carry parent_ref (e.g. PROJ-42) next to parent_id."
			),
			priorities: d(
				ListIssuesSchema.shape.priorities,
				"Comma-separated priorities (OR-matched), e.g. urgent,high"
			),
			assignee: d(
				ListIssuesSchema.shape.assignee,
				'Filter by assignee user ID, or "me" for the calling user'
			),
			parentId: d(
				ListIssuesSchema.shape.parentId,
				"Filter by parent issue ID, or a ref like PROJ-42 (returns direct children only)"
			),
			noParent: flag("Only return issues with no parent (top-level issues)"),
			typeId: d(ListIssuesSchema.shape.typeId, "Filter by task type ID"),
			excludeTypeIds: d(
				ListIssuesSchema.shape.excludeTypeIds,
				"Comma-separated task type IDs to exclude (e.g. the epic type)"
			),
			sprintId: d(ListIssuesSchema.shape.sprintId, "Filter by sprint ID"),
			labels: LabelsFilter(" Paginates like any other filter."),
			labelsMode: LabelsMode,
			cfKey: d(ListIssuesSchema.shape.cfKey, "Custom field key to filter by"),
			cfOp: d(
				ListIssuesSchema.shape.cfOp,
				"Comparison operator for the custom field filter (requires cfKey)"
			),
			cfValue: d(
				ListIssuesSchema.shape.cfValue,
				"Value to compare the custom field against (requires cfKey)"
			),
			completedAfter: d(
				z.number().optional(),
				"Only issues marked completed at or after this epoch-seconds time"
			),
			completedBefore: d(
				z.number().optional(),
				"Only issues marked completed at or before this epoch-seconds time"
			),
			updatedAfter: d(
				z.number().optional(),
				"Only issues last edited at or after this epoch-seconds time"
			),
			updatedBefore: d(
				z.number().optional(),
				"Only issues last edited at or before this epoch-seconds time"
			),
			needsAudit: flag(
				"Filter to agent-initiated done-closures flagged for human audit — true for " +
					"unverifiable evidence, false for externally-checkable evidence"
			),
			includeRollups: flag(
				"Attach a `rollup` of child status counts (total/byStatus/done/remaining) to each returned item"
			),
			includeBody: flag("Include the `body` field on each item (omitted by default)"),
			cursor: d(
				IssueListCursorInput.optional(),
				"Pagination cursor: pass the previous page's `next` unchanged"
			),
			limit: d(z.number().min(1).max(100).default(30), "Max 100"),
			bodyChars: BodyChars,
			...Shape,
		}),
		run: (ctx, input) => listIssues(ctx, serviceInput(input)),
		mcpResult: (result, input) => {
			const { rest: _, ...shape } = splitShapeOpts(input);
			const {
				items: raw,
				nextCursor,
				total,
			} = result as {
				items: Record<string, unknown>[];
				nextCursor: string | null;
				total?: number;
			};
			const page = toPage(
				raw.map((i) => shapeIssue(withBodyPreview(i, input.bodyChars), shape)),
				nextCursor,
				total === undefined ? {} : { total }
			);
			return capPage(page, {
				cursorOf: (i) => (raw[i] ? `${raw[i].created_at}:${raw[i].id}` : undefined),
			});
		},
	}),
	defineOperation({
		...base,
		id: "get_prioritized_issues",
		method: "GET",
		path: "/api/issues/prioritized",
		tier: "read",
		mcpDefaults: { limit: 10, includeBacklog: true, excludeClaimed: false, includeNotReady: false },
		summary:
			"Return open issues ranked by a composite score: link-network centrality (in-degree) + priority + " +
			"inverse story points. Useful for deciding what to work on next. By default, issues that fail the " +
			"definition-of-ready check (missing acceptance criteria or scope/files) are excluded. " +
			"If none of the open issues pass, the ranked (not-ready) list is returned anyway with " +
			"`degraded: true` on the response and `needsGrooming`/`missingCriteria` on each issue, rather than " +
			'an empty array — empty otherwise means "no open work", which would be a lie. ' +
			"Each issue is {ref,title,status,priority,score,needsGrooming?,missingCriteria?}; " +
			"pass verbose:true for ids and the score breakdown.",
		input: z.object({
			limit: d(z.number().optional(), "Max issues to return (default 10, max 100)"),
			includeBacklog: flag("Include backlog-status issues (default true)"),
			excludeClaimed: flag("Skip issues currently held by a live lease (default false)"),
			includeNotReady: flag(
				"Include issues that fail the definition-of-ready check, annotated with " +
					"needsGrooming and missingCriteria (default false)"
			),
			projectId: d(
				z.string().optional(),
				"Scope ranking to a single project's issues (default: workspace-wide, all visible projects)"
			),
			verbose: flag(
				"Return the raw rows (ids, status ids, _score and _score_breakdown) instead of the compact shape"
			),
		}),
		run: (ctx, { verbose: _, ...rest }) => getPrioritizedIssues(ctx, rest),
		mcpResult: (result, input) => {
			if (input.verbose === true) return result;
			const r = result as { issues: PrioritizedRaw[] } & Record<string, unknown>;
			return { ...r, issues: r.issues.map(shapePrioritized) };
		},
	}),
	defineOperation({
		...base,
		id: "search_issues",
		method: "GET",
		path: "/api/issues/search",
		tier: "read",
		restAliases: { q: "query" },
		mcpDefaults: { labelsMode: "all" },
		summary:
			"Search issues by keyword in title or body, or by exact label text (an issue whose label " +
			"equals the whole query is a hit, listed first; case-insensitive for ASCII only). Pass `labels` to narrow keyword hits to " +
			"issues carrying those labels. To list every issue with a label — with pagination — use " +
			"list_issues with `labels` instead; search returns at most 50.",
		input: SearchIssuesInputSchema.extend({
			projectId: d(
				z.string().optional(),
				"Restrict search to a specific project — UUID or project key like PROJ"
			),
			labels: LabelsFilter(""),
			labelsMode: LabelsMode,
			limit: d(SearchIssuesInputSchema.shape.limit, "Max 50"),
			...Shape,
			view: d(
				ShapeOptsSchema.shape.view,
				"summary (default) = {ref,title,status,priority} per hit; full = every non-empty field"
			),
		}),
		run: (ctx, input) => searchIssues(ctx, serviceInput(input)),
		mcpResult: (result, input) => {
			const { rest: _, ...shape } = splitShapeOpts(input);
			const opts =
				shape.view || shape.fields || shape.verbose ? shape : { view: "summary" as const };
			return toPage((result as Record<string, unknown>[]).map((r) => shapeIssue(r, opts)));
		},
	}),
	defineOperation({
		...base,
		id: "get_issues",
		method: "GET",
		path: "/api/issues/batch",
		tier: "read",
		mcpDefaults: { bodyChars: 0 },
		summary:
			"Fetch up to 50 issues in one call, by ref (e.g. PROJ-42) and/or id. Cheaper than " +
			"repeated get_issue calls for triage. Items carry customFields but no rollup/links/" +
			"assignee_name, and omit `body` unless includeBody:true. Returned in the order refs/ids " +
			"were given; `missing` lists (once each) any requested ref/id that didn't resolve or " +
			"isn't visible to you. " +
			OMISSION_NOTE,
		input: GetIssuesBatchSchema.safeExtend({
			refs: d(GetIssuesBatchSchema.shape.refs, "Refs like PROJ-42 (max 50 combined with ids)"),
			ids: d(
				GetIssuesBatchSchema.shape.ids,
				"Issue UUIDs; refs like PROJ-42 are accepted here too (max 50 combined with refs)"
			),
			includeBody: flag("Include each issue's `body` (omitted by default)"),
			bodyChars: BodyChars,
			...Shape,
		}),
		run: (ctx, input) => getIssuesBatch(ctx, serviceInput(input)),
		mcpResult: (result, input) => {
			const { rest: _, ...shape } = splitShapeOpts(input);
			const r = result as { items: Record<string, unknown>[]; missing: string[] };
			return {
				items: r.items.map((i) => shapeIssue(withBodyPreview(i, input.bodyChars), shape)),
				missing: r.missing,
			};
		},
	}),
	defineOperation({
		...base,
		id: "get_issue",
		method: "GET",
		path: "/api/issues/:id",
		tier: "read",
		summary:
			`Get a single issue by ID or project key + number (e.g. "PROJ-42"). \`body\` is returned ` +
			`up to ${ISSUE_BODY_MAX_CHARS} chars; if it is longer the result has \`bodyTruncated:true\`, ` +
			`\`bodyTotalChars\` and \`next\` — pass \`next\` back as \`cursor\` for the rest. ${OMISSION_NOTE}`,
		input: z.object({
			id: IssueIdOrRef,
			cursor: d(
				z.string().optional(),
				"Continue a long body: pass the previous result's `next` unchanged"
			),
			...Shape,
		}),
		run: (ctx, { id }) => getIssue(ctx, ISSUE_REF_PATTERN.test(id) ? { ref: id } : { id }),
		mcpResult: (result, input) => {
			const { rest: _, ...shape } = splitShapeOpts(input);
			const shaped = shapeIssue(result as Record<string, unknown>, shape);
			if (typeof shaped.body !== "string") return shaped;
			const w = windowText(shaped.body, { max: ISSUE_BODY_MAX_CHARS, cursor: input.cursor });
			if (!w.next && input.cursor === undefined) return shaped;
			return {
				...shaped,
				body: w.text,
				bodyTotalChars: w.totalChars,
				...(w.next ? { bodyTruncated: true, next: w.next } : {}),
			};
		},
	}),
	defineOperation({
		...base,
		id: "create_issue",
		method: "POST",
		path: "/api/issues",
		tier: "write",
		status: 201,
		summary:
			"Create a new issue in a project. For an issue an agent should be able to pick up " +
			"autonomously, the body should state acceptance criteria and scope (files/components) " +
			"— see get_workflow's definition of ready. get_prioritized_issues excludes issues " +
			"missing these by default. Verification isn't part of the readiness bar (PROJ-738) — " +
			"it's required later, in the completionReport when entering review/done.",
		input: CreateIssueSchema.extend({
			projectId: d(z.string(), "UUID of the project, or a project key like PROJ"),
			statusId: d(CreateIssueSchema.shape.statusId, "UUID of the task status to assign"),
			assigneeId: d(CreateIssueSchema.shape.assigneeId, "UUID of the user to assign"),
			parentId: d(
				CreateIssueSchema.shape.parentId,
				"UUID of the parent issue, or a ref like PROJ-42 (optional; max depth 5)"
			),
			typeId: d(CreateIssueSchema.shape.typeId, "UUID of the task type to assign"),
			type: d(
				CreateIssueSchema.shape.type,
				"Task type by key or name, case-insensitive (e.g. bug, epic) — the same value list_issues/get_issue return as `type`. Alternative to typeId."
			),
			customFields: d(
				CreateIssueSchema.shape.customFields,
				"Custom field values keyed by field key (see list_custom_field_defs)"
			),
		}),
		run: (ctx, input) => createIssue(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_issue",
		method: "PATCH",
		path: "/api/issues/:id",
		tier: "write",
		summary:
			"Update an issue — status, priority, title, body, assignee, or labels. Review gating: " +
			"pass agentSessionId to identify yourself as an agent; entering in_review as " +
			"an agent requires completionReport. Agents CAN transition directly to done (no human " +
			"approval gate) — but if the completionReport.verification isn't externally checkable (no " +
			"CI run/PR/commit link), the issue is flagged needsAudit:true for after-the-fact human review. " +
			"If the work is only partly done, pass completionReport.remainder when marking done: a follow-up " +
			"issue (same parent and labels, linked follows_from) is created and its ref returned as followUp.ref.",
		input: UpdateIssueSchema.safeExtend({
			id: IssueIdOrRef,
			statusId: d(UpdateIssueSchema.shape.statusId, "UUID of the task status (null to clear)"),
			parentId: d(
				UpdateIssueSchema.shape.parentId,
				"Set or clear the parent issue — UUID or ref like PROJ-42 (null to remove)"
			),
			customFields: d(
				UpdateIssueSchema.shape.customFields,
				"Custom field values keyed by field key (see list_custom_field_defs)"
			),
			agentSessionId: d(
				UpdateIssueSchema.shape.agentSessionId,
				"Your agent session id (from register_agent) — identifies this update as agent-initiated"
			),
			completionReport: d(
				UpdateIssueSchema.shape.completionReport,
				"Required when an agent moves an issue into in_review; also gates the done transition. " +
					"Shape: {summary, verification, prLink?, remainder?} — summary and verification are required."
			),
		}),
		run: (ctx, { id, ...fields }) => updateIssue(ctx, id, fields),
	}),
	defineOperation({
		...base,
		id: "delete_issue",
		method: "DELETE",
		path: "/api/issues/:id",
		tier: "destructive",
		summary: "Delete an issue by ID or ref (e.g. PROJ-42)",
		input: z.object({ id: IssueIdOrRef }),
		run: (ctx, { id }) => deleteIssue(ctx, id),
	}),
];
