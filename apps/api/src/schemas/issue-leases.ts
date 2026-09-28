import { z } from "zod";
import { BooleanQueryParam } from "./common";

export const ClaimIssueSchema = z.object({
	issueId: z.string().uuid(),
	agentId: z.string().uuid(),
});

export const ReleaseIssueSchema = z.object({
	issueId: z.string().uuid(),
	// Restrict the release to a lease held by this agent session (optional).
	agentId: z.string().uuid().optional(),
});

// PROJ-932: projectId accepts a UUID or a project key (e.g. "PROJ"), resolved the same
// way list_issues resolves its projectId filter. includeStale restores the pre-PROJ-932
// behaviour of returning every unreleased lease regardless of session health.
export const ListIssueLeasesSchema = z.object({
	issueId: z.string().uuid().optional(),
	agentId: z.string().uuid().optional(),
	projectId: z.string().optional(),
	includeStale: BooleanQueryParam.optional(),
});
