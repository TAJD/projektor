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
	})
	.refine(
		(d) => {
			if (d.rating === undefined || d.ratingScale === undefined) return true;
			if (d.ratingScale === "thumbs") return d.rating === -1 || d.rating === 1;
			return d.rating >= 1 && d.rating <= 5;
		},
		{ message: "rating must be -1 or 1 for thumbs, or an integer 1-5 for five_star" }
	);

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
		// Optional: REST routes always pass the URL path's projectId (scoping the
		// lookup to that project); MCP tools omit it and stay workspace-scoped.
		projectId: z.string().min(1).optional(),
		name: z.string().min(1).max(100).optional(),
		description: z.string().max(500).nullable().optional(),
		isActive: z.boolean().optional(),
	})
	.refine((d) => d.name !== undefined || d.description !== undefined || d.isActive !== undefined, {
		message: "At least one of name, description, or isActive must be provided",
	});

export const RotateFeedbackSourceSchema = z.object({
	sourceId: z.string(),
	projectId: z.string().min(1).optional(),
});
export const RevokeFeedbackSourceSchema = z.object({
	sourceId: z.string(),
	projectId: z.string().min(1).optional(),
});

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
