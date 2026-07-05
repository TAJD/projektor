import { z } from "zod";

export const CreateProjectSchema = z.object({
	name: z.string().min(1).max(100),
	key: z
		.string()
		.min(1)
		.max(10)
		.regex(/^[A-Z0-9]+$/i)
		.transform((s) => s.toUpperCase()),
	description: z.string().max(500).optional(),
	// PROJ-253: per-project agent WIP cap. null/omitted = workspace default.
	agentWipLimit: z.number().int().min(1).max(100).nullable().optional(),
});

export const UpdateProjectSchema = CreateProjectSchema.partial();
