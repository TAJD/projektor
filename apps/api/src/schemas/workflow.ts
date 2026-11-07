import { z } from "zod";

export const GetWorkflowSchema = z.object({
	ifVersion: z
		.string()
		.max(64)
		.optional()
		.meta({
			description:
				"A version previously returned by get_workflow. If it matches the current version, " +
				"the response is `{ unchanged: true, version }` instead of the full spec.",
		}),
});
