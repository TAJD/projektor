import { z } from "zod";
import { CreateCustomFieldDefSchema, UpdateCustomFieldDefFields } from "../schemas/custom-fields";
import {
	createCustomFieldDef,
	deleteCustomFieldDef,
	listCustomFieldDefs,
	updateCustomFieldDef,
} from "../services/custom-fields";
import { defineOperation } from "./define";

const base = {
	domain: "custom-fields",
	keywords: ["custom fields", "fields", "attributes", "metadata", "schema", "properties"],
};

const IdInput = z.object({ id: z.string().min(1) });

export const customFieldOperations = [
	defineOperation({
		...base,
		id: "list_custom_field_defs",
		method: "GET",
		path: "/api/custom-fields",
		tier: "read",
		summary: "List all custom field definitions for the workspace",
		input: z.object({
			projectId: z.string().optional().meta({
				description:
					"Optional project ID to include project-scoped fields alongside workspace-wide fields",
			}),
		}),
		run: (ctx, { projectId }) => listCustomFieldDefs(ctx, projectId),
	}),
	defineOperation({
		...base,
		id: "create_custom_field_def",
		method: "POST",
		path: "/api/custom-fields",
		tier: "write",
		minRole: "admin",
		status: 201,
		summary: "Create a new custom field definition (owner/admin only)",
		input: CreateCustomFieldDefSchema,
		run: (ctx, input) => createCustomFieldDef(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_custom_field_def",
		method: "PATCH",
		path: "/api/custom-fields/:id",
		tier: "write",
		minRole: "admin",
		summary: "Update a custom field definition label or options (owner/admin only)",
		input: UpdateCustomFieldDefFields.extend(IdInput.shape),
		run: (ctx, { id, ...fields }) => updateCustomFieldDef(ctx, id, fields),
	}),
	defineOperation({
		...base,
		id: "delete_custom_field_def",
		method: "DELETE",
		path: "/api/custom-fields/:id",
		tier: "destructive",
		minRole: "admin",
		summary:
			"Delete a custom field definition (owner/admin only). Fails if any issues have values for this field.",
		input: IdInput,
		run: (ctx, { id }) => deleteCustomFieldDef(ctx, id),
	}),
];
