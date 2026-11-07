import { z } from "zod";

export const GetToolUsageSchema = z
	.object({
		since: z.coerce.number().int().nonnegative().optional().meta({
			description: "Epoch seconds; counts from the start of that UTC day (default 7 days ago)",
		}),
		until: z.coerce
			.number()
			.int()
			.nonnegative()
			.optional()
			.meta({ description: "Epoch seconds (default now)" }),
		tool: z.string().min(1).max(100).optional().meta({ description: "Only this tool" }),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.meta({ description: "Max tools listed (the total still covers every tool)", default: 25 }),
	})
	.strict();
