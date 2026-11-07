import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import { issueMcpView } from "../mcp/serialize";
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
import { getIssue, ISSUE_REF_PATTERN } from "../services/issues";
import { defineOperation } from "./define";

const base = {
	domain: "agents",
	keywords: ["session", "agent", "worker", "heartbeat", "fleet", "who is working"],
};

const verbose = z.boolean().optional().meta({
	description: "Return the raw stored rows instead of the slim shape (default false)",
});

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
			"reclaimable once the session's heartbeat goes stale (120s). Returns {sessionId, leaseId, " +
			"paths, issue}, with issue in get_issue's default shape, so no separate get_issue is needed; " +
			"verbose:true returns the raw rows.",
		input: StartWorkSchema.extend({ verbose }),
		run: async (ctx, { verbose, ...input }) => {
			if (verbose) return startWork(ctx, input);
			const issueKey = ISSUE_REF_PATTERN.test(input.issue)
				? { ref: input.issue }
				: { id: input.issue };
			const [started, issue] = await Promise.allSettled([
				startWork(ctx, input),
				getIssue(ctx, issueKey),
			]);
			if (started.status === "rejected") throw started.reason;
			return issue.status === "fulfilled"
				? { ...started.value, issue: issue.value }
				: started.value;
		},
		mcpResult: (result, { verbose }) => {
			if (verbose) return result;
			const started = result as Awaited<ReturnType<typeof startWork>> & { issue?: unknown };
			return {
				sessionId: started.sessionId,
				leaseId: started.lease.id,
				paths: started.claimedFiles.map((c) => c.path),
				...(started.issue ? { issue: issueMcpView(started.issue) } : {}),
			};
		},
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
			"otherwise the call fails before anything changes, so the session stays live to retry. " +
			"Returns {sessionId, issueRef, status?, followUp?}; verbose:true returns the ended session row.",
		input: FinishWorkSchema.extend({ verbose }),
		run: (ctx, { verbose: _, ...input }) => finishWork(ctx, input),
		mcpResult: (result, input) => {
			if (input.verbose) return result;
			const {
				id,
				workspaceId: _w,
				issueId: _i,
				tokenId: _t,
				name: _n,
				status: _s,
				startedAt: _st,
				lastHeartbeatAt: _h,
				endedAt: _e,
				...extra
			} = result as Awaited<ReturnType<typeof finishWork>>;
			return {
				sessionId: id,
				...(input.status !== undefined ? { status: input.status } : {}),
				...extra,
			};
		},
	}),
	defineOperation({
		...base,
		id: "register_agent",
		method: "POST",
		path: "/api/agents",
		tier: "write",
		annotations: PLAIN_WRITE,
		status: 201,
		summary:
			"Register an agent session, optionally linked to an issue. Returns {id, name}; " +
			"verbose:true returns the stored row.",
		input: RegisterAgentSchema.extend({ verbose }),
		run: (ctx, { verbose: _, ...input }) => registerAgent(ctx, input),
		mcpResult: (result, { verbose }) => {
			const row = result as Awaited<ReturnType<typeof registerAgent>>;
			return verbose ? row : { id: row.id, name: row.name };
		},
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
			'that issue\'s ref (e.g. "PROJ-857") as issueRef. Rows are {id, name, issueRef?, live, ' +
			"startedAt, lastHeartbeatAt}; verbose:true returns the raw rows.",
		input: ListActiveAgentsSchema.extend({
			includeStale: z.boolean().optional().meta({
				description:
					"Include active sessions that have stopped heartbeating (default: false — live entries only). Never includes ended sessions.",
			}),
			verbose,
		}),
		run: (ctx, { verbose: _, ...input }) => listActiveAgents(ctx, input),
		mcpResult: (result, { verbose }) => {
			const page = result as Awaited<ReturnType<typeof listActiveAgents>>;
			if (verbose) return page;
			return {
				items: page.items.map((s) => ({
					id: s.id,
					name: s.name,
					...(s.issueRef ? { issueRef: s.issueRef } : {}),
					live: s.live,
					startedAt: s.startedAt,
					lastHeartbeatAt: s.lastHeartbeatAt,
				})),
			};
		},
	}),
];
