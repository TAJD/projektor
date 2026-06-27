import type { MCPTool } from "@projektor/types";
import { claimFiles, listFileClaims, releaseFiles } from "../services/file-claims";

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
		handler(input, ctx) {
			return releaseFiles(ctx, input);
		},
	},
	{
		name: "list_file_claims",
		description: "List active file claims in the workspace, optionally filtered by issue or path",
		inputSchema: {
			type: "object",
			properties: {
				issueId: { type: "string", description: "Filter by issue UUID (optional)" },
				path: {
					type: "string",
					description:
						"Filter by exact file path — shows who holds this file across issues (optional)",
				},
			},
		},
		handler(input, ctx) {
			return listFileClaims(ctx, input);
		},
	},
];
