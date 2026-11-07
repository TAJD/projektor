import { z } from "zod";

export const CreateProjectSchema = z.object({
	name: z.string().min(1).max(100).meta({ description: "Project name, max 100 characters" }),
	key: z
		.string()
		.min(1)
		.max(10)
		// PROJ-440: no leading digit, so KEY-NUMBER issue refs (ISSUE_REF_PATTERN in
		// services/issues.ts) stay unambiguous.
		.regex(/^[A-Za-z][A-Za-z0-9]*$/)
		.transform((s) => s.toUpperCase())
		.meta({ description: "Short uppercase identifier, e.g. PROJ (max 10 chars, A-Z0-9)" }),
	description: z
		.string()
		.max(500)
		.optional()
		.meta({ description: "Optional description, max 500 characters" }),
	// PROJ-253: per-project agent WIP cap. null/omitted = workspace default.
	agentWipLimit: z.number().int().min(1).max(100).nullable().optional().meta({
		description: "Max issues one agent may hold in this project (null = workspace default)",
	}),
});

export const UpdateProjectSchema = CreateProjectSchema.partial().extend({
	name: CreateProjectSchema.shape.name.optional().meta({ description: "New project name" }),
	key: CreateProjectSchema.shape.key.optional().meta({
		description: "New project key (changes the prefix of the project's issue refs)",
	}),
	archived: z.boolean().optional().meta({ description: "Archive (true) or unarchive (false)" }),
	// PROJ-962: close an epic automatically when its last child is done/cancelled.
	epicAutoClose: z.boolean().optional().meta({
		description:
			"Auto-close an epic when its last child is done/cancelled (default false: hint only)",
	}),
});
