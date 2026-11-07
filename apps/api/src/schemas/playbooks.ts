import { z } from "zod";

const PlaybookName = z.string().meta({ description: 'Playbook name, e.g. "epic-goal"' });

export const GetPlaybookSchema = z.object({ name: PlaybookName.min(1) });

export const ComposePlaybookSchema = z.object({
	name: PlaybookName,
	params: z.object({
		epicRef: z.string().min(1).meta({ description: 'Epic ref, e.g. "PROJ-596"' }),
		variant: z.enum(["bounded", "full"]).optional(),
		reviewModel: z.string().optional(),
		cadence: z.number().int().min(1).optional(),
		checkpointInterval: z
			.number()
			.int()
			.min(1)
			.optional()
			.meta({ description: "Completed tickets between human checkpoints (default 10)" }),
	}),
});
