import { z } from "zod";

const isDefault = z
	.boolean()
	.optional()
	.meta({ description: "Set as the default type for new issues" });

export const CreateTaskTypeSchema = z.object({
	key: z
		.string()
		.min(1)
		.max(50)
		.regex(
			/^[a-z][a-z0-9_]*$/,
			"Key must start with a letter and contain only lowercase letters, digits, or underscores"
		)
		.meta({ description: "Unique key (lowercase letters, digits, underscores)" }),
	name: z.string().min(1).max(100).meta({ description: "Display name" }),
	color: z.string().max(50).optional().meta({ description: "Optional color (hex or named)" }),
	icon: z.string().max(50).optional().meta({ description: "Optional icon identifier" }),
	position: z.number().int().min(0).optional().meta({ description: "Sort order position" }),
	isDefault,
});

export const UpdateTaskTypeFields = z.object({
	name: z.string().min(1).max(100).optional(),
	color: z.string().max(50).nullable().optional(),
	icon: z.string().max(50).nullable().optional(),
	position: z.number().int().min(0).optional(),
	isDefault,
});

export const UpdateTaskTypeSchema = UpdateTaskTypeFields.refine(
	(obj) => Object.keys(obj).length > 0,
	{ message: "Nothing to update" }
);
