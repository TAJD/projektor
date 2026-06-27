import { z } from "zod";

const body = z.string().min(1).max(10000);

export const ListCommentsSchema = z.object({
	issueId: z.string(),
});

export const AddCommentSchema = z.object({
	issueId: z.string(),
	body,
});

export const UpdateCommentSchema = z.object({
	issueId: z.string(),
	commentId: z.string(),
	body,
});

export const DeleteCommentSchema = z.object({
	issueId: z.string(),
	commentId: z.string(),
});
