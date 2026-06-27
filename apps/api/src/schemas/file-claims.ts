import { z } from "zod";

export const ClaimFilesSchema = z.object({
	issueId: z.string().uuid(),
	agentId: z.string().uuid().optional(),
	paths: z.array(z.string().min(1).max(400)).min(1).max(100),
	force: z.boolean().optional(),
});

export const ReleaseFilesSchema = z.object({
	paths: z.array(z.string()).min(1),
	issueId: z.string().uuid().optional(),
});

export const ListFileClaimsSchema = z.object({
	issueId: z.string().uuid().optional(),
	path: z.string().optional(),
});
