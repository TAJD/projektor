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

// PROJ-332: group claims one path segment below `prefix` — the natural "list this
// directory's children" step a file explorer takes, so the caller drills down by
// re-requesting with `prefix` set to the entry clicked.
function groupClaimsByNextSegment(
	claims: Array<{ path: string; issueId: string }>,
	prefix: string
): CodeHeatmapEntry[] {
	const prefixWithSlash = prefix ? `${prefix}/` : "";
	const groups = new Map<string, { issueIds: Set<string>; claimCount: number; isLeaf: boolean }>();

	for (const claim of claims) {
		if (prefix && !claim.path.startsWith(prefixWithSlash)) continue;
		const rest = claim.path.slice(prefixWithSlash.length);
		if (!rest) continue;
		const slashIdx = rest.indexOf("/");
		const isLeaf = slashIdx === -1;
		const segment = isLeaf ? rest : rest.slice(0, slashIdx);
		const path = prefix ? `${prefix}/${segment}` : segment;

		let group = groups.get(path);
		if (!group) {
			group = { issueIds: new Set(), claimCount: 0, isLeaf };
			groups.set(path, group);
		}
		// A path claimed as both a file and a directory (e.g. `docs` and `docs/x.md`) is a
		// directory: keep it drillable rather than freezing isLeaf on the first claim seen.
		if (!isLeaf) group.isLeaf = false;
		group.issueIds.add(claim.issueId);
		group.claimCount++;
	}

	return [...groups.entries()]
		.map(([path, group]) => ({
			path,
			segment: path.slice(prefixWithSlash.length),
			isLeaf: group.isLeaf,
			distinctIssueCount: group.issueIds.size,
			claimCount: group.claimCount,
		}))
		.sort((a, b) => b.distinctIssueCount - a.distinctIssueCount || a.path.localeCompare(b.path));
}

export async function getCodeHeatmap(ctx: ServiceCtx, raw: unknown) {
	const result = GetCodeHeatmapSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { projectId, since, until, prefix } = result.data;

	await assertProjectExists(ctx, projectId);

	const orm = drizzle(ctx.db, { schema });

	// Default window mirrors flow-metrics' throughput default (current ISO week plus the
	// preceding 5 weeks) so the heatmap agrees with the rest of the dashboard when no
	// explicit range is passed.
	const now = Math.floor(Date.now() / 1000);
	const windowSince = since ?? now - 42 * 86400;
	const windowUntil = until ?? now;

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
		totalDistinctIssues: new Set(claims.map((c) => c.issueId)).size,
		entries,
	};
}
