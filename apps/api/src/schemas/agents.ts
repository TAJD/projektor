import { z } from "zod";
import { BooleanQueryParam, StatusEnum } from "./common";
import { CompletionReportSchema } from "./issues";

export const RegisterAgentSchema = z.object({
	issueId: z.string().uuid().optional(),
	name: z.string().min(1).max(200),
	// PROJ-336: deprecated — accepted for MCP client compatibility but ignored by
	// the service (see services/agents.ts). It was the original spoofable
	// review-gate signal; PROJ-287 rebound the gate to live leases instead.
	kind: z.enum(["agent", "human"]).optional(),
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
	issueId: z.string().uuid().optional(),
	projectId: z.string().optional(),
	includeStale: BooleanQueryParam.optional(),
});

// PROJ-929: register + claim_issue + claim_files + post_message in one atomic call.
// `issue` (not `issueId`) and `name` match the AC's literal parameter names.
export const StartWorkSchema = z
	.object({
		issue: z.string().uuid(),
		paths: z.array(z.string().min(1).max(400)).max(100).optional(),
		name: z.string().min(1).max(200),
	})
	.strict();

// PROJ-929: optionally transitions the issue via the existing update path (so
// completion-report rules apply unchanged), then releases everything the session
// holds and ends it — same effect as release_issue + release_files + end_agent.
export const FinishWorkSchema = z
	.object({
		sessionId: z.string().uuid(),
		issue: z.string().uuid(),
		completionReport: CompletionReportSchema.optional(),
		status: StatusEnum.optional(),
	})
	.strict();
