import { z } from "zod";

export const GetFlowMetricsSchema = z.object({
	projectId: z.string().min(1),
	since: z.number().int().nonnegative().optional(),
	until: z.number().int().nonnegative().optional(),
	granularity: z.enum(["day", "week"]).default("week"),
});
