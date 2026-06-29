import type { MCPTool } from "@projektor/types";
import { claimIssue, listIssueLeases, releaseIssue } from "../services/issue-leases";

export const issueLeasesTools: MCPTool[] = [
	{
		name: "claim_issue",
		description:
			"Atomically lease an issue to an agent session so the parallel fleet doesn't double-work it. Fails if another live session already holds it; reclaims a lease whose session stopped heartbeating.",
		inputSchema: {
			type: "object",
			required: ["issueId", "agentId"],
			properties: {
				issueId: { type: "string", description: "Issue UUID to lease" },
				agentId: {
					type: "string",
					description: "Agent session UUID acquiring the lease (must be live)",
				},
			},
		},
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
		handler(input, ctx) {
			return releaseIssue(ctx, input);
		},
	},
	{
		name: "list_issue_leases",
		description:
			"List active issue leases in the workspace, optionally filtered by issue or agent. Each entry's `live` flag is false when the holder stopped heartbeating (lease is reclaimable).",
		inputSchema: {
			type: "object",
			properties: {
				issueId: { type: "string", description: "Filter to leases on this issue (optional)" },
				agentId: { type: "string", description: "Filter to leases held by this agent (optional)" },
			},
		},
		handler(input, ctx) {
			return listIssueLeases(ctx, input);
		},
	},
];
