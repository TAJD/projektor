import type { MCPTool } from "@projektor/types";
import { claimIssue, listIssueLeases, releaseIssue } from "../services/issue-leases";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./annotations";

export const issueLeasesTools: MCPTool[] = [
	{
		name: "claim_issue",
		description:
			"Atomically lease an issue to an agent session so the parallel fleet doesn't double-work it. " +
			"Fails if another live session already holds it; reclaims a lease whose session stopped heartbeating.",
		inputSchema: {
			type: "object",
			required: ["issueId"],
			properties: {
				issueId: { type: "string", description: "Issue UUID to lease" },
				agentId: {
					type: "string",
					description:
						"Agent session UUID acquiring the lease (must be live). Optional when this credential has exactly one live session; fleets sharing a credential must pass it",
				},
			},
		},
		annotations: IDEMPOTENT_WRITE,
		handler(input, ctx) {
			return claimIssue(ctx, input);
		},
	},
	{
		name: "release_issue",
		description:
			"Release the active lease on an issue, optionally only if held by a given agent session",
		inputSchema: {
			type: "object",
			required: ["issueId"],
			properties: {
				issueId: { type: "string", description: "Issue UUID to release" },
				agentId: {
					type: "string",
					description: "Only release if the lease is held by this agent session (optional)",
				},
			},
		},
		annotations: DESTRUCTIVE,
		handler(input, ctx) {
			return releaseIssue(ctx, input);
		},
	},
	{
		name: "list_issue_leases",
		description:
			"List active issue leases in the workspace, optionally filtered by issue, agent or project. " +
			"Live entries only by default — a lease whose agent session has ended or stopped " +
			"heartbeating is excluded; pass includeStale:true for all. Each entry carries the linked " +
			'issue\'s ref (e.g. "PROJ-857") as issueRef, and a `live` flag (false when the holder ' +
			"stopped heartbeating and the lease is reclaimable — only possible with includeStale:true).",
		inputSchema: {
			type: "object",
			properties: {
				issueId: { type: "string", description: "Filter to leases on this issue (optional)" },
				agentId: { type: "string", description: "Filter to leases held by this agent (optional)" },
				projectId: {
					type: "string",
					description:
						"Filter to leases on issues in this project — UUID or project key (optional)",
				},
				includeStale: {
					type: "boolean",
					description:
						"Include leases whose agent session has ended or gone stale (default: false — live entries only)",
				},
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return listIssueLeases(ctx, input);
		},
	},
];
