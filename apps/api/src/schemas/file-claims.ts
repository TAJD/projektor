import { z } from "zod";
import { BooleanQueryParam } from "./common";

export const ClaimFilesSchema = z.object({
	issueId: z.string().uuid(),
	agentId: z.string().uuid().optional(),
	paths: z.array(z.string().min(1).max(400)).min(1).max(100),
	force: z.boolean().optional(),
});

export const ReleaseFilesSchema = z.object({
	paths: z.array(z.string()).min(1),
	issueId: z.string().uuid().optional(),
});

// PROJ-932: projectId accepts a UUID or a project key, resolved the same way list_issues
// resolves its projectId filter. includeStale restores the pre-PROJ-932 behaviour of
// returning every unreleased claim regardless of holder health.
export const ListFileClaimsSchema = z.object({
	issueId: z.string().uuid().optional(),
	path: z.string().optional(),
	projectId: z.string().optional(),
	includeStale: BooleanQueryParam.optional(),
});
