import { z } from "zod";

const body = z.string().min(1).max(10000);
const issueId = z.string().meta({ description: "UUID of the issue, or a ref like PROJ-42" });

export const ListCommentsSchema = z.object({
	issueId,
});

export const AddCommentSchema = z.object({
	issueId,
	body,
});

export const UpdateCommentSchema = z.object({
	issueId,
	commentId: z.string(),
	body,
});

export const DeleteCommentSchema = z.object({
	issueId,
	commentId: z.string(),
});
