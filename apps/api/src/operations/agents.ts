import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import {
	FinishWorkSchema,
	ListActiveAgentsSchema,
	RegisterAgentSchema,
	StartWorkSchema,
} from "../schemas/agents";
import {
	endAgent,
	finishWork,
	heartbeatAgent,
	listActiveAgents,
	registerAgent,
	startWork,
} from "../services/agents";
import { ValidationError } from "../services/errors";
import { defineOperation } from "./define";

const base = {
	domain: "agents",
	keywords: ["session", "agent", "worker", "heartbeat", "fleet", "who is working"],
};

const SessionRef = z.object({
	id: z.string().uuid().optional().meta({
		description:
			"Agent session UUID. Optional when this credential has exactly one agent session; fleets sharing a credential must pass it",
	}),
	agentId: z
		.string()
		.uuid()
		.optional()
		.meta({ description: "Alias for `id` (the name claim_issue uses)" }),
});

function sessionId({ id, agentId }: z.output<typeof SessionRef>) {
	if (id !== undefined && agentId !== undefined && id !== agentId) {
		throw new ValidationError({
			formErrors: [],
			fieldErrors: { agentId: ["conflicts with id — pass one of them"] },
		});
	}
	return { id: id ?? agentId };
}

export const agentOperations = [
	defineOperation({
		...base,
		id: "start_work",
		method: "POST",
		path: "/api/agents/start-work",
		tier: "write",
		annotations: PLAIN_WRITE,
		status: 201,
		summary:
			"Register an agent session and claim an issue (plus files, if given) in one call — " +
			"replaces register_agent + claim_issue + claim_files + post_message. All-or-nothing with " +
			"compensating cleanup: on any conflict (same errors as claim_issue/claim_files) the session is " +
			"ended and nothing is left claimed. If the process crashes mid-call, the same claims become " +
			"reclaimable once the session's heartbeat goes stale (120s).",
		input: StartWorkSchema,
		run: (ctx, input) => startWork(ctx, input),
	}),
	defineOperation({
		...base,
		id: "finish_work",
		method: "POST",
		path: "/api/agents/finish-work",
		tier: "write",
		annotations: PLAIN_WRITE,
		summary:
			"Optionally transition an issue (completion-report rules apply, same as update_issue), then " +
			"release every claim/lease the session holds and end it — replaces update_issue + " +
			"release_issue + release_files + end_agent. completionReport.remainder on a done transition " +
			"creates a linked follow-up issue; its ref comes back as followUp.ref. A completionReport " +
			"needs a status that moves the issue to in_review/done (or an issue already there); " +
			"otherwise the call fails before anything changes, so the session stays live to retry.",
		input: FinishWorkSchema,
		run: (ctx, input) => finishWork(ctx, input),
	}),
	defineOperation({
		...base,
		id: "register_agent",
		method: "POST",
		path: "/api/agents",
		tier: "write",
		annotations: PLAIN_WRITE,
		status: 201,
		summary: "Register an agent session, optionally linked to an issue",
		input: RegisterAgentSchema,
		run: (ctx, input) => registerAgent(ctx, input),
	}),
	defineOperation({
		...base,
		id: "heartbeat_agent",
		method: "POST",
		path: "/api/agents/:id/heartbeat",
		tier: "write",
		annotations: PLAIN_WRITE,
		summary: "Send a heartbeat to keep an agent session active",
		input: SessionRef,
		run: (ctx, input) => heartbeatAgent(ctx, sessionId(input)),
	}),
	defineOperation({
		...base,
		id: "end_agent",
		method: "POST",
		path: "/api/agents/:id/end",
		tier: "write",
		annotations: PLAIN_WRITE,
		summary: "End an agent session",
		input: SessionRef,
		run: (ctx, input) => endAgent(ctx, sessionId(input)),
	}),
	defineOperation({
		...base,
		id: "list_active_agents",
		method: "GET",
		path: "/api/agents",
		tier: "read",
		summary:
			"List agent sessions in the workspace, optionally filtered by issue or project. An ended " +
			"session is never returned. Live entries only by default — a session that has stopped " +
			"heartbeating is also excluded; pass includeStale:true to include those too. Each entry " +
			"carries a `live` flag (false when its heartbeat has gone stale) and, when tied to an issue, " +
			'that issue\'s ref (e.g. "PROJ-857") as issueRef.',
		input: ListActiveAgentsSchema.extend({
			includeStale: z.boolean().optional().meta({
				description:
					"Include active sessions that have stopped heartbeating (default: false — live entries only). Never includes ended sessions.",
			}),
		}),
		run: (ctx, input) => listActiveAgents(ctx, input),
	}),
];
