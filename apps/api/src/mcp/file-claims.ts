import type { MCPTool } from "@projektor/types";
import { claimFiles, listFileClaims, releaseFiles } from "../services/file-claims";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./annotations";

export const fileClaimsTools: MCPTool[] = [
	{
		name: "claim_files",
		description:
			"Claim one or more repo file paths for an issue so the parallel fleet can see what is taken",
		inputSchema: {
			type: "object",
			required: ["issueId", "paths"],
			properties: {
				issueId: { type: "string", description: "Issue UUID to associate the claims with" },
				agentId: {
					type: "string",
					description: "Agent session UUID claiming the files (optional)",
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description: "File paths to claim (1–100 paths, each max 400 chars)",
				},
				force: {
					type: "boolean",
					description: "When true, steal claims held by other issues/agents (default: false)",
				},
			},
		},
		annotations: IDEMPOTENT_WRITE,
		handler(input, ctx) {
			return claimFiles(ctx, input);
		},
	},
	{
		name: "release_files",
		description: "Release active file claims in the workspace, optionally scoped to an issue",
		inputSchema: {
			type: "object",
			required: ["paths"],
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description: "File paths to release",
				},
				issueId: {
					type: "string",
					description: "Restrict release to claims held by this issue (optional)",
				},
			},
		},
		annotations: DESTRUCTIVE,
		handler(input, ctx) {
			return releaseFiles(ctx, input);
		},
	},
	{
		name: "list_file_claims",
		description:
			"List active file claims in the workspace, optionally filtered by issue, path or project. " +
			"Live entries only by default — a claim whose holder has ended, stopped heartbeating, or " +
			"(for an agentless claim) sat past its TTL is excluded; pass includeStale:true for all. " +
			'Each entry carries the linked issue\'s ref (e.g. "PROJ-857") as issueRef, and a `live` ' +
			"flag (false when the claim is reclaimable — only possible with includeStale:true).",
		inputSchema: {
			type: "object",
			properties: {
				issueId: { type: "string", description: "Filter by issue UUID (optional)" },
				path: {
					type: "string",
					description:
						"Filter by exact file path — shows who holds this file across issues (optional)",
				},
				projectId: {
					type: "string",
					description:
						"Filter to claims on issues in this project — UUID or project key (optional)",
				},
				includeStale: {
					type: "boolean",
					description:
						"Include claims whose holder has ended, gone stale, or (agentless) passed its TTL (default: false — live entries only)",
				},
			},
		},
		annotations: READ,
		handler(input, ctx) {
			return listFileClaims(ctx, input);
		},
	},
];
