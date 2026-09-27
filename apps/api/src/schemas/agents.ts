import { z } from "zod";
import { StatusEnum } from "./common";
import { CompletionReportSchema } from "./issues";

export const RegisterAgentSchema = z.object({
	issueId: z.string().uuid().optional(),
	name: z.string().min(1).max(200),
	// PROJ-336: deprecated — accepted for MCP client compatibility but ignored by
	// the service (see services/agents.ts). It was the original spoofable
	// review-gate signal; PROJ-287 rebound the gate to live leases instead.
	kind: z.enum(["agent", "human"]).optional(),
});

export const HeartbeatAgentSchema = z.object({
	id: z.string().uuid(),
});

export const EndAgentSchema = z.object({
	id: z.string().uuid(),
});

export const ListActiveAgentsSchema = z.object({
	issueId: z.string().uuid().optional(),
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
