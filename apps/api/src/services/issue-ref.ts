import { drizzle, schema } from "@projektor/db";
import { and, eq, or } from "drizzle-orm";
import { ISSUE_REF_PATTERN } from "../schemas/common";
import { effectiveProjectRole, isWorkspaceAdmin, visibleProjectPredicate } from "./access";
import { NotFoundError } from "./errors";
import type { ServiceCtx } from "./types";

export { ISSUE_REF_PATTERN };

/**
 * Accept either identifier wherever an issue id is taken: a UUID passes straight through
 * (no query), a ref like "PROJ-42" is looked up.
 *
 * PROJ-438: only `GET /api/issues/:id` understood a ref, so a browser landing on
 * /projects/KEY/N/… had to resolve the UUID and only then ask for that issue's comments
 * and links — a full round trip of dead time on the critical path, per sub-resource.
 * PROJ-959: the MCP tools (add_comment, claim_issue, claim_files, …) had the same gap, which
 * agents hit as "Issue not found" after passing a ref. Services now resolve at their entry
 * point, so REST and MCP behave identically.
 *
 * This resolves within `ctx.workspaceId` only, and answers "not found" for a ref that
 * doesn't, so it can't be used to probe for issues in another workspace.
 *
 * It does NOT check project visibility, and a ref — unlike a UUID — is enumerable
 * (PROJ-1, PROJ-2, …). Use it ONLY where the returned id goes straight into code that
 * enforces visibility itself and answers a hidden issue exactly as it answers an unknown
 * one (PROJ-311): the comments service, issue links, and issues.ts. Everywhere else use
 * {@link resolveVisibleIssueIdParam}, which applies the visibility rule itself.
 */
export async function resolveIssueIdParam(
	ctx: ServiceCtx,
	param: string,
	notFoundMessage = "Issue not found"
): Promise<string> {
	const m = param.match(ISSUE_REF_PATTERN);
	if (!m) return param;

	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.where(
			and(
				eq(schema.projects.key, m[1]),
				eq(schema.issues.number, parseInt(m[2], 10)),
				eq(schema.issues.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!row) throw new NotFoundError(notFoundMessage);
	return row.id;
}

/**
 * Like {@link resolveIssueIdParam}, but a ref only resolves to an issue in a project the
 * caller can see (owner/admin see all; everyone else needs a group grant — PROJ-311). A
 * ref to a hidden issue throws the SAME `NotFoundError` as a ref to no issue at all, so the
 * resolution can't be used to count which issues exist in projects the caller was never
 * granted, nor to learn a hidden issue's UUID.
 *
 * A UUID gets the same check (PROJ-976): it must be in this workspace and in a project the
 * caller can see, else the same `NotFoundError`.
 */
export async function resolveVisibleIssueIdParam(
	ctx: ServiceCtx,
	param: string,
	notFoundMessage = "Issue not found"
): Promise<string> {
	const m = param.match(ISSUE_REF_PATTERN);
	if (!m) {
		const orm = drizzle(ctx.db, { schema });
		const found = await orm
			.select({ id: schema.issues.id })
			.from(schema.issues)
			.where(
				and(
					eq(schema.issues.id, param),
					eq(schema.issues.workspaceId, ctx.workspaceId),
					visibleProjectPredicate(ctx, schema.issues.projectId)
				)
			)
			.get();
		if (!found) throw new NotFoundError(notFoundMessage);
		return found.id;
	}

	const orm = drizzle(ctx.db, { schema });
	const row = await orm
		.select({ id: schema.issues.id, projectId: schema.issues.projectId })
		.from(schema.issues)
		.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
		.where(
			and(
				eq(schema.projects.key, m[1]),
				eq(schema.issues.number, parseInt(m[2], 10)),
				eq(schema.issues.workspaceId, ctx.workspaceId)
			)
		)
		.get();
	if (!row) throw new NotFoundError(notFoundMessage);
	if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, row.projectId)) === null) {
		throw new NotFoundError(notFoundMessage);
	}
	return row.id;
}

/**
 * {@link resolveVisibleIssueIdParam} for an optional *filter or link* value, with one
 * difference: a ref or UUID that doesn't resolve (unknown OR hidden) returns an
 * `unresolved:`-prefixed value instead of throwing.
 *
 * That value can never equal an issue UUID, so a filter on it matches nothing (an empty
 * list), and a caller that goes on to look the issue up (register_agent) still gets its own
 * "Issue not found". Unknown and hidden ids therefore answer identically — a list call
 * can't tell "no such issue" from "no results".
 */
export async function resolveOptionalIssueId(
	ctx: ServiceCtx,
	param: string | undefined
): Promise<string | undefined> {
	if (param === undefined) return undefined;
	try {
		return await resolveVisibleIssueIdParam(ctx, param);
	} catch (e) {
		if (e instanceof NotFoundError) return `unresolved:${param}`;
		throw e;
	}
}

// Each (key, number) pair binds two parameters. D1 rejects a query binding more than 100,
// and the same statement also binds the workspace id and the visibility predicate's user
// id, so 40 pairs (80 params) leaves comfortable headroom.
const REF_PAIRS_PER_QUERY = 40;

/**
 * Resolve a batch (e.g. move_issues_to_sprint's `issueIds`, up to 500), preserving order.
 * UUIDs cost nothing. Refs are looked up as (project key, number) pairs, REF_PAIRS_PER_QUERY
 * to a query — so 500 refs cost at most 13 queries however many distinct project keys they
 * span — and only resolve to issues in projects the caller can see.
 *
 * Any ref that doesn't resolve fails the whole batch as "Issue not found: <the ref as the
 * caller wrote it>". Unknown and hidden refs are indistinguishable, and the error never
 * names a UUID.
 */
export async function resolveIssueIdsParam(ctx: ServiceCtx, params: string[]): Promise<string[]> {
	const pairs = new Map<string, { key: string; number: number }>();
	for (const p of params) {
		const m = p.match(ISSUE_REF_PATTERN);
		if (!m) continue;
		const number = parseInt(m[2], 10);
		pairs.set(`${m[1]}-${number}`, { key: m[1], number });
	}
	if (pairs.size === 0) return params;

	const orm = drizzle(ctx.db, { schema });
	const visible = visibleProjectPredicate(ctx, schema.issues.projectId);
	const all = [...pairs.values()];
	const resolved = new Map<string, string>();
	for (let i = 0; i < all.length; i += REF_PAIRS_PER_QUERY) {
		const chunk = all.slice(i, i + REF_PAIRS_PER_QUERY);
		const rows = await orm
			.select({
				id: schema.issues.id,
				key: schema.projects.key,
				number: schema.issues.number,
			})
			.from(schema.issues)
			.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
			.where(
				and(
					eq(schema.issues.workspaceId, ctx.workspaceId),
					or(
						...chunk.map((p) =>
							and(eq(schema.projects.key, p.key), eq(schema.issues.number, p.number))
						)
					),
					visible
				)
			);
		for (const row of rows) resolved.set(`${row.key}-${row.number}`, row.id);
	}

	return params.map((p) => {
		const m = p.match(ISSUE_REF_PATTERN);
		if (!m) return p;
		// Look up through the same normalised key the map was built with, so "PROJ-007" and
		// "PROJ-7" are the same issue.
		const id = resolved.get(`${m[1]}-${parseInt(m[2], 10)}`);
		if (!id) throw new NotFoundError(`Issue not found: ${p}`);
		return id;
	});
}

/**
 * Normalise an agent-message channel scope. "issue:PROJ-42" becomes "issue:<uuid>" so a
 * message posted by ref and one posted by UUID land in — and are read from — the same
 * channel; "workspace" and already-canonical scopes pass through unchanged.
 *
 * Visibility-aware like every ref resolution here: a hidden ref is "Issue not found".
 * `lenient` (the read path) instead returns the scope unchanged for a ref that doesn't
 * resolve — no channel is ever stored under a raw ref, so the listing is empty, exactly as
 * an unknown UUID scope already is.
 */
export async function resolveMessageScope(
	ctx: ServiceCtx,
	scope: string,
	opts: Readonly<{ lenient?: boolean }> = {}
): Promise<string> {
	if (!scope.startsWith("issue:")) return scope;
	const target = scope.slice("issue:".length);
	if (opts.lenient) {
		const resolved = await resolveOptionalIssueId(ctx, target);
		return `issue:${resolved}`;
	}
	return `issue:${await resolveVisibleIssueIdParam(ctx, target)}`;
}
