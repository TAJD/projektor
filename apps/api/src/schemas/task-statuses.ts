import { z } from "zod";

export const CategoryEnum = z.enum(["todo", "in_progress", "done", "cancelled"]);

export const CreateTaskStatusSchema = z.object({
	key: z
		.string()
		.min(1)
		.max(50)
		.regex(
			/^[a-z][a-z0-9_]*$/,
			"Key must start with a letter and contain only lowercase letters, digits, or underscores"
		),
	name: z.string().min(1).max(100),
	category: CategoryEnum,
	color: z.string().max(50).optional(),
	position: z.number().int().min(0).optional(),
	isDefault: z.boolean().optional(),
});

export const UpdateTaskStatusSchema = z
	.object({
		name: z.string().min(1).max(100).optional(),
		category: CategoryEnum.optional(),
		color: z.string().max(50).nullable().optional(),
		position: z.number().int().min(0).optional(),
		isDefault: z.boolean().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });
