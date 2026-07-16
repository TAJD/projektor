import { z } from "zod";

const RatingScaleEnum = z.enum(["thumbs", "five_star"]);
const FeedbackStatusEnum = z.enum(["new", "reviewed", "actioned"]);

export const SubmitFeedbackSchema = z
	.object({
		rating: z.number().int().optional(),
		ratingScale: RatingScaleEnum.optional(),
		body: z.string().min(1).max(10000).optional(),
		submitterLabel: z.string().max(200).optional(),
		sourceUrl: z.string().max(2000).optional(),
		appVersion: z.string().max(100).optional(),
	})
	.refine((d) => d.rating !== undefined || d.body !== undefined, {
		message: "At least one of rating or body must be provided",
	})
	.refine((d) => (d.rating === undefined) === (d.ratingScale === undefined), {
		message: "ratingScale is required when rating is present, and forbidden otherwise",
	});

export const CreateFeedbackSourceSchema = z.object({
	projectId: z.string().min(1, "projectId is required"),
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
	allowedOrigins: z.array(z.string().max(2000)).max(50).optional(),
});

export const ListFeedbackSourcesSchema = z.object({
	projectId: z.string().min(1, "projectId is required"),
});

export const UpdateFeedbackSourceSchema = z
	.object({
		sourceId: z.string(),
		name: z.string().min(1).max(100).optional(),
		description: z.string().max(500).nullable().optional(),
		isActive: z.boolean().optional(),
	})
	.refine((d) => d.name !== undefined || d.description !== undefined || d.isActive !== undefined, {
		message: "At least one of name, description, or isActive must be provided",
	});

export const RotateFeedbackSourceSchema = z.object({ sourceId: z.string() });
export const RevokeFeedbackSourceSchema = z.object({ sourceId: z.string() });

export const ListFeedbackSchema = z.object({
	projectId: z.string().min(1, "projectId is required"),
	status: FeedbackStatusEnum.optional(),
	sourceId: z.string().optional(),
});

export const UpdateFeedbackSchema = z.object({
	projectId: z.string().min(1, "projectId is required"),
	feedbackId: z.string(),
	status: FeedbackStatusEnum,
});

export const ConvertFeedbackSchema = z.object({
	projectId: z.string().min(1, "projectId is required"),
	feedbackId: z.string(),
});
