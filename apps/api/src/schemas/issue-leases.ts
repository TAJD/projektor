import { z } from "zod";
import { BooleanQueryParam, IssueIdOrRefSchema } from "./common";

export const ClaimIssueSchema = z.object({
	issueId: IssueIdOrRefSchema.meta({ description: "Issue UUID or ref like PROJ-42, to lease" }),
	// PROJ-894: optional when the calling credential owns exactly one live agent session
	// (services/agent-identity.ts resolves it); otherwise the caller must pass it.
	agentId: z.string().uuid().optional().meta({
		description:
			"Agent session UUID acquiring the lease (must be live). Optional when this credential has exactly one live session; fleets sharing a credential must pass it",
	}),
});

export const ReleaseIssueSchema = z.object({
	issueId: IssueIdOrRefSchema.meta({ description: "Issue UUID or ref like PROJ-42, to release" }),
	// Restrict the release to a lease held by this agent session (optional).
	agentId: z.string().uuid().optional().meta({
		description: "Only release if the lease is held by this agent session (optional)",
	}),
});

// PROJ-932: projectId accepts a UUID or a project key (e.g. "PROJ"), resolved the same
// way list_issues resolves its projectId filter. includeStale restores the pre-PROJ-932
// behaviour of returning every unreleased lease regardless of session health.
export const ListIssueLeasesSchema = z.object({
	issueId: IssueIdOrRefSchema.optional().meta({
		description: "Filter to leases on this issue, UUID or ref like PROJ-42 (optional)",
	}),
	agentId: z
		.string()
		.uuid()
		.optional()
		.meta({ description: "Filter to leases held by this agent (optional)" }),
	projectId: z.string().optional().meta({
		description: "Filter to leases on issues in this project — UUID or project key (optional)",
	}),
	includeStale: BooleanQueryParam.optional(),
});
