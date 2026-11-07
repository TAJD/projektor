import { z } from "zod";
import { BooleanQueryParam, IssueIdOrRefSchema, StatusEnum } from "./common";
import { CompletionReportSchema } from "./issues";

const AgentName = z
	.string()
	.min(1)
	.max(200)
	.meta({ description: "Display name for the agent session (max 200)" });

export const RegisterAgentSchema = z.object({
	issueId: IssueIdOrRefSchema.optional().meta({
		description: "Issue UUID or ref like PROJ-42, to link this session to (optional)",
	}),
	name: AgentName,
	// PROJ-336: deprecated — accepted for MCP client compatibility but ignored by
	// the service (see services/agents.ts). It was the original spoofable
	// review-gate signal; PROJ-287 rebound the gate to live leases instead.
	kind: z.enum(["agent", "human"]).optional().meta({
		description:
			"Deprecated, ignored (PROJ-336): self-declared session kind drives no behavior and is not returned.",
	}),
});

// PROJ-894: `id` may be omitted when the calling credential owns exactly one agent
// session — see services/agent-identity.ts. Fleets sharing a credential must pass it.
export const HeartbeatAgentSchema = z.object({
	id: z.string().uuid().optional(),
});

export const EndAgentSchema = z.object({
	id: z.string().uuid().optional(),
});

// PROJ-932: projectId accepts a UUID or a project key, resolved the same way list_issues
// resolves its projectId filter. includeStale widens the default live-only filter to
// every session in the workspace, including ended/stale ones.
export const ListActiveAgentsSchema = z.object({
	issueId: IssueIdOrRefSchema.optional().meta({
		description: "Filter by issue UUID or ref like PROJ-42 (optional)",
	}),
	projectId: z
		.string()
		.optional()
		.meta({
			description:
				"Filter to sessions linked to an issue in this project — UUID or project key. " +
				"A session with no issue link is excluded when this is given (optional)",
		}),
	includeStale: BooleanQueryParam.optional(),
});

// PROJ-929: register + claim_issue + claim_files + post_message in one atomic call.
// `issue` (not `issueId`) and `name` match the AC's literal parameter names.
export const StartWorkSchema = z
	.object({
		issue: IssueIdOrRefSchema.meta({ description: "Issue UUID or ref like PROJ-42, to claim" }),
		paths: z
			.array(z.string().min(1).max(400))
			.max(100)
			.optional()
			.meta({ description: "File paths to claim alongside the issue (optional)" }),
		name: AgentName,
	})
	.strict();

// PROJ-929: optionally transitions the issue via the existing update path (so
// completion-report rules apply unchanged), then releases everything the session
// holds and ends it — same effect as release_issue + release_files + end_agent.
export const FinishWorkSchema = z
	.object({
		sessionId: z.string().uuid().meta({ description: "Agent session UUID to end" }),
		issue: IssueIdOrRefSchema.meta({
			description: "Issue UUID or ref like PROJ-42, to optionally transition",
		}),
		completionReport: CompletionReportSchema.optional().meta({
			description:
				"Completion report, required by the review gate in the same cases update_issue requires it (optional). " +
				"Shape: {summary, verification, prLink?, remainder?} — summary and verification are required.",
		}),
		status: StatusEnum.optional().meta({ description: "New status for the issue (optional)" }),
	})
	.strict();
