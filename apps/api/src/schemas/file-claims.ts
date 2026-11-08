import { z } from "zod";
import { BooleanQueryParam, IssueIdOrRefSchema } from "./common";

export const ClaimFilesSchema = z.object({
	issueId: IssueIdOrRefSchema.meta({
		description: "Issue UUID or ref like PROJ-42, to associate the claims with",
	}),
	agentId: z
		.string()
		.uuid()
		.optional()
		.meta({ description: "Agent session UUID claiming the files (optional)" }),
	paths: z
		.array(z.string().min(1).max(400))
		.min(1)
		.max(100)
		.meta({ description: "File paths to claim (1–100 paths, each max 400 chars)" }),
	force: z.boolean().optional().meta({
		description: "When true, steal claims held by other issues/agents (default: false)",
	}),
});

export const ReleaseFilesSchema = z.object({
	paths: z.array(z.string()).min(1).optional().meta({
		description: "File paths to release; omit to release by agentId / issueId / session",
	}),
	issueId: IssueIdOrRefSchema.optional().meta({
		description:
			"Restrict release to claims held by this issue, UUID or ref like PROJ-42 (optional)",
	}),
	agentId: z.string().min(1).max(200).optional().meta({
		description:
			"Agent session UUID, or the session name given to register_agent/start_work, whose claims to release when paths is omitted (optional)",
	}),
});

// PROJ-932: projectId accepts a UUID or a project key, resolved the same way list_issues
// resolves its projectId filter. includeStale restores the pre-PROJ-932 behaviour of
// returning every unreleased claim regardless of holder health.
export const ListFileClaimsSchema = z.object({
	issueId: IssueIdOrRefSchema.optional().meta({
		description: "Filter by issue UUID or ref like PROJ-42 (optional)",
	}),
	path: z.string().optional().meta({
		description: "Filter by exact file path — shows who holds this file across issues (optional)",
	}),
	projectId: z.string().optional().meta({
		description: "Filter to claims on issues in this project — UUID or project key (optional)",
	}),
	includeStale: BooleanQueryParam.optional(),
});
