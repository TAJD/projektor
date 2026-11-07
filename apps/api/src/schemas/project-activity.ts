import { z } from "zod";

export const ListProjectActivitySchema = z.object({
	projectId: z.string().uuid().meta({ description: "The project UUID to fetch activity for" }),
	since: z
		.number()
		.int()
		.optional()
		.meta({ description: "Unix timestamp - only return events created at or after this time" }),
	limit: z
		.number()
		.int()
		.min(1)
		.max(200)
		.default(50)
		.meta({ description: "Maximum number of events to return (default 50, max 200)" }),
});
