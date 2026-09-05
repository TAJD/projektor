import { z } from "zod";

export const ComposePlaybookSchema = z.object({
	name: z.string(),
	params: z.object({
		epicRef: z.string(),
		variant: z.enum(["bounded", "full"]).optional(),
		reviewModel: z.string().optional(),
		cadence: z.number().int().positive().optional(),
		checkpointInterval: z.number().int().positive().optional(),
	}),
});
