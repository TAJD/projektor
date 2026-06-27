import { z } from "zod";

export const SprintStatusEnum = z.enum(["planned", "active", "completed"]);

export const ListSprintsSchema = z.object({
	projectId: z.string().uuid(),
});

export const CreateSprintSchema = z.object({
	projectId: z.string().uuid(),
	name: z.string().min(1).max(255),
	goal: z.string().max(2000).optional(),
	startDate: z.number().int().optional(),
	endDate: z.number().int().optional(),
});

export const UpdateSprintSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		goal: z.string().max(2000).nullable().optional(),
		status: SprintStatusEnum.optional(),
		startDate: z.number().int().nullable().optional(),
		endDate: z.number().int().nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, { message: "Nothing to update" });

export const MoveIssuesToSprintSchema = z.object({
	issueIds: z.array(z.string().uuid()).min(1).max(500),
	sprintId: z.string().uuid(),
});
