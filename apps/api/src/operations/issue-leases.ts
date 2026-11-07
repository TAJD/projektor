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
			"Fails if another live session already holds it; reclaims a lease whose session stopped heartbeating.",
		input: ClaimIssueSchema,
		run: (ctx, input) => claimIssue(ctx, input),
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
			"stopped heartbeating and the lease is reclaimable — only possible with includeStale:true).",
		input: ListIssueLeasesSchema.extend({
			includeStale: z.boolean().optional().meta({
				description:
					"Include leases whose agent session has ended or gone stale (default: false — live entries only)",
			}),
		}),
		run: (ctx, input) => listIssueLeases(ctx, input),
	}),
];
