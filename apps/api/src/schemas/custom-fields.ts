import { z } from "zod";

export const CustomFieldTypeEnum = z.enum(["text", "number", "select", "date", "user"]);

export const CreateCustomFieldDefSchema = z.object({
	key: z
		.string()
		.min(1)
		.max(50)
		.regex(
			/^[a-z][a-z0-9_]*$/,
			"Key must start with a letter and contain only lowercase letters, digits, or underscores"
		),
	label: z.string().min(1).max(100),
	type: CustomFieldTypeEnum,
	options: z.array(z.string().min(1).max(100)).max(100).optional(),
	projectId: z.string().uuid().nullable().optional(),
});

export const UpdateCustomFieldDefSchema = z
	.object({
		label: z.string().min(1).max(100).optional(),
		options: z.array(z.string().min(1).max(100)).max(100).nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const CustomFieldFilterSchema = z.object({
	cfKey: z.string().optional(),
	cfOp: z.enum(["eq", "gt", "gte", "lt", "lte"]).optional(),
	cfValue: z.string().optional(),
});
