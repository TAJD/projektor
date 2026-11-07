import { z } from "zod";
import { IDEMPOTENT_WRITE } from "../mcp/annotations";
import { OMISSION_NOTE } from "../mcp/serialize";
import { ClaimFilesSchema, ListFileClaimsSchema, ReleaseFilesSchema } from "../schemas/file-claims";
import {
	claimFiles,
	DEFAULT_FILE_CLAIM_TTL_SECONDS,
	listFileClaims,
	releaseFiles,
} from "../services/file-claims";
import type { ServiceCtx } from "../services/types";
import { defineOperation } from "./define";

const base = {
	domain: "file-claims",
	keywords: ["lock", "files", "conflict", "who is editing", "reserve", "paths"],
};

const verbose = z.boolean().optional().meta({
	description: "Return the raw stored rows instead of the slim shape (default false)",
});

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

export const fileClaimOperations = [
	defineOperation({
		...base,
		id: "claim_files",
		method: "POST",
		path: "/api/file-claims",
		tier: "write",
		annotations: IDEMPOTENT_WRITE,
		status: 201,
		summary:
			"Claim one or more repo file paths for an issue so the parallel fleet can see what is taken. " +
			"Returns {created, overridden, reclaimed}, each a list of {path, agentId, claimedAt, expiresAt?}; " +
			"expiresAt is set only on an agentless claim, which lapses after its TTL. " +
			OMISSION_NOTE,
		input: ClaimFilesSchema.extend({ verbose }),
		run: (ctx, input) => claimFiles(ctx, input),
		mcpResult: (result, input, ctx) => {
			const claimed = result as Awaited<ReturnType<typeof claimFiles>>;
			if (input.verbose) return claimed;
			return {
				created: claimed.created.map((row) => slimClaim(ctx, row)),
				overridden: claimed.overridden.map((row) => slimClaim(ctx, row)),
				reclaimed: claimed.reclaimed.map((row) => slimClaim(ctx, row)),
			};
		},
	}),
	defineOperation({
		...base,
		id: "release_files",
		method: "POST",
		path: "/api/file-claims/release",
		tier: "destructive",
		summary:
			"Release file claims. With paths: releases those paths (optionally only those held by an " +
			"issue). Without paths it releases everything held by agentId; else, with only issueId, the " +
			"caller's claims on that issue; else everything held by the credential's single agent " +
			"session (several live sessions: pass agentId). Returns {released: n, paths: [...]}.",
		input: ReleaseFilesSchema,
		run: (ctx, input) => releaseFiles(ctx, input),
		mcpResult: (result) => {
			const { released } = result as Awaited<ReturnType<typeof releaseFiles>>;
			return { released: released.length, paths: released.map((row) => row.path) };
		},
	}),
	defineOperation({
		...base,
		id: "list_file_claims",
		method: "GET",
		path: "/api/file-claims",
		tier: "read",
		summary:
			"List active file claims in the workspace, optionally filtered by issue, path or project. " +
			"Live entries only by default — a claim whose holder has ended, stopped heartbeating, or " +
			"(for an agentless claim) sat past its TTL is excluded; pass includeStale:true for all. " +
			"Returns {items} of {path, agentId, issueRef, claimedAt, expiresAt?}; expiresAt is set only on " +
			"an agentless claim, and stale:true marks a reclaimable claim (only possible with " +
			"includeStale:true). " +
			OMISSION_NOTE,
		input: ListFileClaimsSchema.extend({
			includeStale: z.boolean().optional().meta({
				description:
					"Include claims whose holder has ended, gone stale, or (agentless) passed its TTL (default: false — live entries only)",
			}),
			verbose,
		}),
		run: (ctx, input) => listFileClaims(ctx, input),
		mcpResult: (result, input, ctx) => {
			const page = result as Awaited<ReturnType<typeof listFileClaims>>;
			if (input.verbose) return page;
			return {
				items: page.items.map((row) => ({
					...slimClaim(ctx, row),
					...(row.live ? {} : { stale: true }),
				})),
			};
		},
	}),
];
