import { z } from "zod";

const CustomFieldTypeEnum = z.enum(["text", "number", "select", "date", "user"]);

const OptionsSchema = z.array(z.string().min(1).max(100)).max(100);

export const CreateCustomFieldDefSchema = z.object({
	key: z
		.string()
		.min(1)
		.max(50)
		.regex(
			/^[a-z][a-z0-9_]*$/,
			"Key must start with a letter and contain only lowercase letters, digits, or underscores"
		)
		.meta({ description: "Unique key (lowercase letters, digits, underscores)" }),
	label: z.string().min(1).max(100).meta({ description: "Human-readable label" }),
	type: CustomFieldTypeEnum.meta({ description: "Field type" }),
	options: OptionsSchema.optional().meta({
		description: "Allowed options (required for select type)",
	}),
	projectId: z
		.string()
		.uuid()
		.nullable()
		.optional()
		.meta({ description: "Scope to a specific project (null = workspace-wide)" }),
});

export const UpdateCustomFieldDefFields = z.object({
	label: z.string().min(1).max(100).optional(),
	options: OptionsSchema.nullable().optional(),
});

export const UpdateCustomFieldDefSchema = UpdateCustomFieldDefFields.refine(
	(obj) => Object.keys(obj).length > 0,
	{ message: "Nothing to update" }
);

export const CustomFieldFilterSchema = z.object({
	cfKey: z.string().optional(),
	cfOp: z.enum(["eq", "gt", "gte", "lt", "lte"]).optional(),
	cfValue: z.string().optional(),
});
