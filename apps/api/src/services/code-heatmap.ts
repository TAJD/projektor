import { drizzle, schema } from "@projektor/db";
import { and, eq, gte, lte } from "drizzle-orm";
import { GetCodeHeatmapSchema } from "../schemas/code-heatmap";
import { effectiveProjectRole, isWorkspaceAdmin } from "./access";
import { NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

async function assertProjectExists(ctx: ServiceCtx, projectId: string): Promise<void> {
	const orm = drizzle(ctx.db, { schema });
	const project = await orm
		.select({ id: schema.projects.id })
		.from(schema.projects)
		.where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, ctx.workspaceId)))
		.get();
	if (!project) throw new NotFoundError("Project not found");
	// PROJ-311: a non-admin without a grant can't see the project's metrics.
	if (!isWorkspaceAdmin(ctx.role) && (await effectiveProjectRole(ctx, projectId)) === null) {
		throw new NotFoundError("Project not found");
	}
}

export interface CodeHeatmapEntry {
	// Full path from the workspace root to this segment (the drill-down cursor for a
	// non-leaf entry's children).
	path: string;
	// This entry's own path component, relative to the request's `prefix`.
	segment: string;
	// True when this entry is an exact claimed file path (no further segments beneath
	// it) rather than a directory grouping further claims.
	isLeaf: boolean;
	distinctIssueCount: number;
	claimCount: number;
}

// PROJ-338: contention-mode counterpart to CodeHeatmapEntry — sized by claim_conflicts
// (rejected/overridden claimFiles attempts) instead of successful claims.
export interface ContentionHeatmapEntry {
	path: string;
	segment: string;
	isLeaf: boolean;
	distinctRejectedIssueCount: number;
	conflictCount: number;
}

// Resolves the path segment one level below `prefix` that `itemPath` falls under, or null
// if `itemPath` IS `prefix` (nothing left to drill into).
function resolveNextSegment(
	itemPath: string,
	prefix: string,
	prefixWithSlash: string
): { path: string; isLeaf: boolean } | null {
	const rest = itemPath.slice(prefixWithSlash.length);
	if (!rest) return null;
	const slashIdx = rest.indexOf("/");
	const isLeaf = slashIdx === -1;
	const segment = isLeaf ? rest : rest.slice(0, slashIdx);
	const path = prefix ? `${prefix}/${segment}` : segment;
	return { path, isLeaf };
}

type SegmentGroup = { ids: Set<string>; count: number; isLeaf: boolean };

// PROJ-332/338: group items (claims or conflicts) one path segment below `prefix` — the
// natural "list this directory's children" step a file explorer takes, so the caller
// drills down by re-requesting with `prefix` set to the entry clicked. Shared by
// groupClaimsByNextSegment and groupConflictsByNextSegment (below), which differ only in
// how they extract the distinct id to count per group.
function groupItemsByNextSegment<T extends { path: string }>(
	items: ReadonlyArray<T>,
	prefix: string,
	prefixWithSlash: string,
	getId: (item: T) => string
): Map<string, SegmentGroup> {
	const groups = new Map<string, SegmentGroup>();

	for (const item of items) {
		if (prefix && !item.path.startsWith(prefixWithSlash)) continue;
		const resolved = resolveNextSegment(item.path, prefix, prefixWithSlash);
		if (!resolved) continue;
		const { path, isLeaf } = resolved;

		let group = groups.get(path);
		if (!group) {
			group = { ids: new Set(), count: 0, isLeaf };
			groups.set(path, group);
		}
		// A path claimed as both a file and a directory (e.g. `docs` and `docs/x.md`) is a
		// directory: keep it drillable rather than freezing isLeaf on the first item seen.
		if (!isLeaf) group.isLeaf = false;
		group.ids.add(getId(item));
		group.count++;
	}

	return groups;
}

function groupClaimsByNextSegment(
	claims: ReadonlyArray<{ path: string; issueId: string }>,
	prefix: string
): CodeHeatmapEntry[] {
	const prefixWithSlash = prefix ? `${prefix}/` : "";
	const groups = groupItemsByNextSegment(claims, prefix, prefixWithSlash, (c) => c.issueId);

	return [...groups.entries()]
		.map(([path, group]) => ({
			path,
			segment: path.slice(prefixWithSlash.length),
			isLeaf: group.isLeaf,
			distinctIssueCount: group.ids.size,
			claimCount: group.count,
		}))
		.sort((a, b) => b.distinctIssueCount - a.distinctIssueCount || a.path.localeCompare(b.path));
}

function groupConflictsByNextSegment(
	conflicts: ReadonlyArray<{ path: string; rejectedIssueId: string }>,
	prefix: string
): ContentionHeatmapEntry[] {
	const prefixWithSlash = prefix ? `${prefix}/` : "";
	const groups = groupItemsByNextSegment(
		conflicts,
		prefix,
		prefixWithSlash,
		(c) => c.rejectedIssueId
	);

	return [...groups.entries()]
		.map(([path, group]) => ({
			path,
			segment: path.slice(prefixWithSlash.length),
			isLeaf: group.isLeaf,
			distinctRejectedIssueCount: group.ids.size,
			conflictCount: group.count,
		}))
		.sort(
			(a, b) =>
				b.distinctRejectedIssueCount - a.distinctRejectedIssueCount || a.path.localeCompare(b.path)
		);
}

export async function getCodeHeatmap(ctx: ServiceCtx, raw: unknown) {
	const result = GetCodeHeatmapSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { projectId, since, until, prefix, mode } = result.data;

	await assertProjectExists(ctx, projectId);

	const orm = drizzle(ctx.db, { schema });

	// Default window mirrors flow-metrics' throughput default (current ISO week plus the
	// preceding 5 weeks) so the heatmap agrees with the rest of the dashboard when no
	// explicit range is passed.
	const now = Math.floor(Date.now() / 1000);
	const windowSince = since ?? now - 42 * 86400;
	const windowUntil = until ?? now;

	const resolvedMode = mode ?? "claims";

	if (resolvedMode === "contention") {
		// PROJ-338: same window predicate as claims mode, but over claim_conflicts —
		// occurredAt within [since, until], joined to issues (via rejectedIssueId) to scope
		// by project.
		const conflicts = await orm
			.select({
				path: schema.claimConflicts.path,
				rejectedIssueId: schema.claimConflicts.rejectedIssueId,
			})
			.from(schema.claimConflicts)
			.innerJoin(schema.issues, eq(schema.claimConflicts.rejectedIssueId, schema.issues.id))
			.where(
				and(
					eq(schema.claimConflicts.workspaceId, ctx.workspaceId),
					eq(schema.issues.projectId, projectId),
					gte(schema.claimConflicts.occurredAt, windowSince),
					lte(schema.claimConflicts.occurredAt, windowUntil)
				)
			);

		const entries = groupConflictsByNextSegment(conflicts, prefix ?? "");

		return {
			prefix: prefix ?? "",
			mode: resolvedMode,
			// Reuses the claims-mode field name so the response shape doesn't fork in two —
			// here it's the distinct count of *rejected* issues, i.e. issues whose claim
			// attempt lost.
			totalDistinctIssues: new Set(conflicts.map((c) => c.rejectedIssueId)).size,
			entries,
		};
	}

	// PROJ-332: window predicate matches the rest of flow-metrics — claimedAt within
	// [since, until], not claim overlap. issue_file_claims has no project column, so join
	// issues to scope by project.
	const claims = await orm
		.select({ path: schema.issueFileClaims.path, issueId: schema.issueFileClaims.issueId })
		.from(schema.issueFileClaims)
		.innerJoin(schema.issues, eq(schema.issueFileClaims.issueId, schema.issues.id))
		.where(
			and(
				eq(schema.issueFileClaims.workspaceId, ctx.workspaceId),
				eq(schema.issues.projectId, projectId),
				gte(schema.issueFileClaims.claimedAt, windowSince),
				lte(schema.issueFileClaims.claimedAt, windowUntil)
			)
		);

	const entries = groupClaimsByNextSegment(claims, prefix ?? "");

	return {
		prefix: prefix ?? "",
		mode: resolvedMode,
		totalDistinctIssues: new Set(claims.map((c) => c.issueId)).size,
		entries,
	};
}
