import { drizzle, schema } from "@projektor/db";
import { and, eq, inArray } from "drizzle-orm";
import { ISSUE_REF_PATTERN } from "../schemas/common";
import { NotFoundError } from "./errors";
import { inChunks } from "./sql";
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
 * It does NOT check project visibility. Every caller hands the returned id straight to
 * code that does (PROJ-311), and duplicating the check here would be a second place to get
 * it wrong. If you add a caller, confirm that holds for yours too — an id from this
 * function is workspace-scoped and nothing more.
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
 * Same as {@link resolveIssueIdParam} for an optional *filter or link* value, with one
 * difference: a ref that matches no issue is returned unchanged instead of throwing.
 *
 * A raw ref string can never equal an issue UUID, so a filter on it matches nothing (an
 * empty list), and a caller that goes on to look the issue up (register_agent) still gets
 * its own "Issue not found". That keeps these paths from answering "no such ref" for one
 * the caller can't see differently from "no results" for one they can: a throwing resolver
 * here would let a list call probe which refs exist in projects the caller has no grant on.
 */
export async function resolveOptionalIssueId(
	ctx: ServiceCtx,
	param: string | undefined
): Promise<string | undefined> {
	if (param === undefined) return undefined;
	try {
		return await resolveIssueIdParam(ctx, param);
	} catch (e) {
		if (e instanceof NotFoundError) return param;
		throw e;
	}
}

/**
 * Resolve a batch (e.g. move_issues_to_sprint's `issueIds`, up to 500), preserving order.
 * UUIDs cost nothing. Refs are grouped by project key and looked up with one chunked query
 * per key (not one query per ref), through `inChunks` so no query binds more than D1's
 * 100-parameter cap. Any ref that doesn't resolve fails the whole batch as "not found",
 * naming the ref, rather than silently dropping it.
 */
export async function resolveIssueIdsParam(ctx: ServiceCtx, params: string[]): Promise<string[]> {
	const numbersByKey = new Map<string, Set<number>>();
	for (const p of params) {
		const m = p.match(ISSUE_REF_PATTERN);
		if (!m) continue;
		const set = numbersByKey.get(m[1]) ?? new Set<number>();
		set.add(parseInt(m[2], 10));
		numbersByKey.set(m[1], set);
	}
	if (numbersByKey.size === 0) return params;

	const orm = drizzle(ctx.db, { schema });
	const resolved = new Map<string, string>();
	for (const [key, numbers] of numbersByKey) {
		const rows = await inChunks([...numbers], (chunk) =>
			orm
				.select({ id: schema.issues.id, number: schema.issues.number })
				.from(schema.issues)
				.innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
				.where(
					and(
						eq(schema.projects.key, key),
						eq(schema.issues.workspaceId, ctx.workspaceId),
						inArray(schema.issues.number, chunk)
					)
				)
		);
		for (const row of rows) resolved.set(`${key}-${row.number}`, row.id);
	}

	return params.map((p) => {
		if (!ISSUE_REF_PATTERN.test(p)) return p;
		// Normalise "PROJ-007" style spellings through the same key the map used.
		const m = p.match(ISSUE_REF_PATTERN) as RegExpMatchArray;
		const id = resolved.get(`${m[1]}-${parseInt(m[2], 10)}`);
		if (!id) throw new NotFoundError(`Issue not found: ${p}`);
		return id;
	});
}

/**
 * Normalise an agent-message channel scope. "issue:PROJ-42" becomes "issue:<uuid>" so a
 * message posted by ref and one posted by UUID land in — and are read from — the same
 * channel; "workspace" and already-canonical scopes pass through unchanged.
 */
export async function resolveMessageScope(ctx: ServiceCtx, scope: string): Promise<string> {
	if (!scope.startsWith("issue:")) return scope;
	return `issue:${await resolveIssueIdParam(ctx, scope.slice("issue:".length))}`;
}
