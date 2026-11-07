import { z } from "zod";

const CategoryEnum = z.enum(["todo", "in_progress", "done", "cancelled"]);

const isDefault = z
	.boolean()
	.optional()
	.meta({ description: "Set as the default status for new issues" });
const isReviewStep = z.boolean().optional().meta({
	description:
		"Mark this status as a review step (completion-report gate, review flow metrics). Not inferred from the key.",
});
const isBacklog = z.boolean().optional().meta({
	description:
		"Count issues in this status as backlog on the project tile. Not inferred from the key.",
});

export const CreateTaskStatusSchema = z.object({
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
	category: CategoryEnum.meta({ description: "Workflow bucket" }),
	color: z.string().max(50).optional().meta({ description: "Optional color (hex or named)" }),
	position: z.number().int().min(0).optional().meta({ description: "Sort order position" }),
	isDefault,
	isReviewStep,
	isBacklog,
});

export const UpdateTaskStatusFields = z.object({
	name: z.string().min(1).max(100).optional(),
	category: CategoryEnum.optional(),
	color: z.string().max(50).nullable().optional(),
	position: z.number().int().min(0).optional(),
	isDefault,
	isReviewStep,
	isBacklog,
});

export const UpdateTaskStatusSchema = UpdateTaskStatusFields.refine(
	(obj) => Object.keys(obj).length > 0,
	{ message: "Nothing to update" }
);
