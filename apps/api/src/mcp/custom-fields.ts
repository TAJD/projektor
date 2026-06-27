import type { MCPTool } from "@projektor/types";
import {
	createCustomFieldDef,
	deleteCustomFieldDef,
	listCustomFieldDefs,
	updateCustomFieldDef,
} from "../services/custom-fields";
import { ValidationError } from "../services/errors";

export const customFieldsTools: MCPTool[] = [
	{
		name: "list_custom_field_defs",
		description: "List all custom field definitions for the workspace",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description:
						"Optional project ID to include project-scoped fields alongside workspace-wide fields",
				},
			},
		},
		handler(input, ctx) {
			const { projectId } = (input as { projectId?: string }) ?? {};
			return listCustomFieldDefs(ctx, projectId);
		},
	},
	{
		name: "create_custom_field_def",
		description: "Create a new custom field definition (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["key", "label", "type"],
			properties: {
				key: { type: "string", description: "Unique key (lowercase letters, digits, underscores)" },
				label: { type: "string", description: "Human-readable label" },
				type: {
					type: "string",
					enum: ["text", "number", "select", "date", "user"],
					description: "Field type",
				},
				options: {
					type: "array",
					items: { type: "string" },
					description: "Allowed options (required for select type)",
				},
				projectId: {
					type: "string",
					nullable: true,
					description: "Scope to a specific project (null = workspace-wide)",
				},
			},
		},
		handler(input, ctx) {
			return createCustomFieldDef(ctx, input);
		},
	},
	{
		name: "update_custom_field_def",
		description: "Update a custom field definition label or options (owner/admin only)",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				label: { type: "string" },
				options: { type: "array", items: { type: "string" }, nullable: true },
			},
		},
		handler(input, ctx) {
			const { id, ...fields } = input as { id?: string; [k: string]: unknown };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return updateCustomFieldDef(ctx, id, fields);
		},
	},
	{
		name: "delete_custom_field_def",
		description:
			"Delete a custom field definition (owner/admin only). Fails if any issues have values for this field.",
		inputSchema: {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
			},
		},
		handler(input, ctx) {
			const { id } = input as { id?: string };
			if (!id || typeof id !== "string") {
				throw new ValidationError({ formErrors: ["id is required"], fieldErrors: {} });
			}
			return deleteCustomFieldDef(ctx, id);
		},
	},
];
