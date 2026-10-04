import { z } from "zod";
import { BooleanQueryParam, IssueIdOrRefSchema } from "./common";

export const ClaimIssueSchema = z.object({
	issueId: IssueIdOrRefSchema,
	// PROJ-894: optional when the calling credential owns exactly one live agent session
	// (services/agent-identity.ts resolves it); otherwise the caller must pass it.
	agentId: z.string().uuid().optional(),
});

export const ReleaseIssueSchema = z.object({
	issueId: IssueIdOrRefSchema,
	// Restrict the release to a lease held by this agent session (optional).
	agentId: z.string().uuid().optional(),
});

// PROJ-932: projectId accepts a UUID or a project key (e.g. "PROJ"), resolved the same
// way list_issues resolves its projectId filter. includeStale restores the pre-PROJ-932
// behaviour of returning every unreleased lease regardless of session health.
export const ListIssueLeasesSchema = z.object({
	issueId: IssueIdOrRefSchema.optional(),
	agentId: z.string().uuid().optional(),
	projectId: z.string().optional(),
	includeStale: BooleanQueryParam.optional(),
});
