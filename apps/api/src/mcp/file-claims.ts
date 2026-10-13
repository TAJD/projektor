import type { MCPTool } from "@projektor/types";
import {
	claimFiles,
	DEFAULT_FILE_CLAIM_TTL_SECONDS,
	listFileClaims,
	releaseFiles,
} from "../services/file-claims";
import type { ServiceCtx } from "../services/types";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./annotations";
import { OMISSION_NOTE } from "./serialize";

type ClaimRow = { path: string; agentId: string | null; claimedAt: number; issueRef?: string };

function slimClaim(ctx: ServiceCtx, row: ClaimRow): Record<string, unknown> {
	const ttl = ctx.config?.fileClaimTtlSeconds ?? DEFAULT_FILE_CLAIM_TTL_SECONDS;
	return {
		path: row.path,
		agentId: row.agentId,
		...(row.issueRef ? { issueRef: row.issueRef } : {}),
		claimedAt: row.claimedAt,
		...(row.agentId === null ? { expiresAt: row.claimedAt + ttl } : {}),
	};
}

export const fileClaimsTools: MCPTool[] = [
	{
		name: "claim_files",
		description:
			"Claim one or more repo file paths for an issue so the parallel fleet can see what is taken. " +
			"Returns {created, overridden, reclaimed}, each a list of {path, agentId, claimedAt, expiresAt?}; " +
			"expiresAt is set only on an agentless claim, which lapses after its TTL. " +
			OMISSION_NOTE,
		inputSchema: {
			type: "object",
			required: ["issueId", "paths"],
			properties: {
				issueId: {
					type: "string",
					description: "Issue UUID or ref like PROJ-42, to associate the claims with",
				},
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
				verbose: {
					type: "boolean",
					description: "Return the raw stored rows instead of the slim shape (default false)",
				},
			},
		},
		annotations: IDEMPOTENT_WRITE,
		async handler(input, ctx) {
			const result = await claimFiles(ctx, input);
			if ((input as { verbose?: unknown } | undefined)?.verbose === true) return result;
			return {
				created: result.created.map((row) => slimClaim(ctx, row)),
				overridden: result.overridden.map((row) => slimClaim(ctx, row)),
				reclaimed: result.reclaimed.map((row) => slimClaim(ctx, row)),
			};
		},
	},
	{
		name: "release_files",
		description:
			"Release file claims. With paths: releases those paths (optionally only those held by an " +
			"issue). Without paths it releases everything held by agentId; else, with only issueId, the " +
			"caller's claims on that issue; else everything held by the credential's single agent " +
			"session (several live sessions: pass agentId). Returns {released: n, paths: [...]}.",
		inputSchema: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description: "File paths to release; omit to release by agentId / issueId / session",
				},
				issueId: {
					type: "string",
					description:
						"Restrict release to claims held by this issue, UUID or ref like PROJ-42 (optional)",
				},
				agentId: {
					type: "string",
					description:
						"Agent session UUID whose claims to release when paths is omitted (optional)",
				},
			},
		},
		annotations: DESTRUCTIVE,
		async handler(input, ctx) {
			const { released } = await releaseFiles(ctx, input);
			return { released: released.length, paths: released.map((row) => row.path) };
		},
	},
	{
		name: "list_file_claims",
		description:
			"List active file claims in the workspace, optionally filtered by issue, path or project. " +
			"Live entries only by default — a claim whose holder has ended, stopped heartbeating, or " +
			"(for an agentless claim) sat past its TTL is excluded; pass includeStale:true for all. " +
			"Returns {items} of {path, agentId, issueRef, claimedAt, expiresAt?}; expiresAt is set only on " +
			"an agentless claim, and stale:true marks a reclaimable claim (only possible with " +
			"includeStale:true). " +
			OMISSION_NOTE,
		inputSchema: {
			type: "object",
			properties: {
				issueId: {
					type: "string",
					description: "Filter by issue UUID or ref like PROJ-42 (optional)",
				},
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
				verbose: {
					type: "boolean",
					description: "Return the raw stored rows instead of the slim shape (default false)",
				},
			},
		},
		annotations: READ,
		async handler(input, ctx) {
			const page = await listFileClaims(ctx, input);
			if ((input as { verbose?: unknown } | undefined)?.verbose === true) return page;
			return {
				items: page.items.map((row) => ({
					...slimClaim(ctx, row),
					...(row.live ? {} : { stale: true }),
				})),
			};
		},
	},
];
