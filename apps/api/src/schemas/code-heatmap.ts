import { z } from "zod";

export const GetCodeHeatmapSchema = z.object({
	projectId: z.string().min(1).meta({ description: "Project UUID" }),
	since: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.meta({ description: "Only claims claimed at/after this epoch-seconds time" }),
	until: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.meta({ description: "Only claims claimed at/before this epoch-seconds time" }),
	prefix: z
		.string()
		.optional()
		.meta({ description: "Directory path to drill into; omit for the top-level segments" }),
	mode: z
		.enum(["claims", "contention"])
		.optional()
		.meta({
			description:
				'"claims" (default) sizes by file-claim volume; "contention" sizes by ' +
				"claim_conflicts — rejected/overridden claimFiles attempts, i.e. where the fleet " +
				"queued up.",
		}),
});
