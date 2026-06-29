import { z } from "zod";

export const ClaimIssueSchema = z.object({
	issueId: z.string().uuid(),
	agentId: z.string().uuid(),
});

export const ReleaseIssueSchema = z.object({
	issueId: z.string().uuid(),
	// Restrict the release to a lease held by this agent session (optional).
	agentId: z.string().uuid().optional(),
});

export const ListIssueLeasesSchema = z.object({
	issueId: z.string().uuid().optional(),
	agentId: z.string().uuid().optional(),
});
