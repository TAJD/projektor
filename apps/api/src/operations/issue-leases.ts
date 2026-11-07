import { z } from "zod";
import { IDEMPOTENT_WRITE } from "../mcp/annotations";
import {
	ClaimIssueSchema,
	ListIssueLeasesSchema,
	ReleaseIssueSchema,
} from "../schemas/issue-leases";
import { claimIssue, listIssueLeases, releaseIssue } from "../services/issue-leases";
import { defineOperation } from "./define";

const base = {
	domain: "issue-leases",
	keywords: ["lease", "lock", "claim", "own", "reserve", "double work"],
};

const verbose = z.boolean().optional().meta({
	description: "Return the raw stored rows instead of the slim shape (default false)",
});

export const issueLeaseOperations = [
	defineOperation({
		...base,
		id: "claim_issue",
		method: "POST",
		path: "/api/issues/:issueId/claim",
		tier: "write",
		annotations: IDEMPOTENT_WRITE,
		status: 201,
		summary:
			"Atomically lease an issue to an agent session so the parallel fleet doesn't double-work it. " +
			"Fails if another live session already holds it; reclaims a lease whose session stopped heartbeating. " +
			"Returns {leaseId, issueRef}; verbose:true returns the lease row.",
		input: ClaimIssueSchema.extend({ verbose }),
		run: (ctx, { verbose: _, ...input }) => claimIssue(ctx, input),
		mcpResult: (result, { verbose }) => {
			const lease = result as Awaited<ReturnType<typeof claimIssue>>;
			return verbose ? lease : { leaseId: lease.id, issueRef: lease.issueRef };
		},
	}),
	defineOperation({
		...base,
		id: "release_issue",
		method: "POST",
		path: "/api/issues/:issueId/release",
		tier: "destructive",
		summary:
			"Release the active lease on an issue, optionally only if held by a given agent session",
		input: ReleaseIssueSchema,
		run: (ctx, input) => releaseIssue(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_issue_leases",
		method: "GET",
		path: "/api/issue-leases",
		tier: "read",
		summary:
			"List active issue leases in the workspace, optionally filtered by issue, agent or project. " +
			"Live entries only by default — a lease whose agent session has ended or stopped " +
			"heartbeating is excluded; pass includeStale:true for all. Each entry carries the linked " +
			'issue\'s ref (e.g. "PROJ-857") as issueRef, and a `live` flag (false when the holder ' +
			"stopped heartbeating and the lease is reclaimable — only possible with includeStale:true). " +
			"Rows omit issueId; verbose:true returns the raw rows.",
		input: ListIssueLeasesSchema.extend({
			includeStale: z.boolean().optional().meta({
				description:
					"Include leases whose agent session has ended or gone stale (default: false — live entries only)",
			}),
			verbose,
		}),
		run: (ctx, { verbose: _, ...input }) => listIssueLeases(ctx, input),
		mcpResult: (result, { verbose }) => {
			const page = result as Awaited<ReturnType<typeof listIssueLeases>>;
			if (verbose) return page;
			return { items: page.items.map(({ issueId: _id, ...row }) => row) };
		},
	}),
];
