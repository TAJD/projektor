import { drizzle, schema } from "@projektor/db";
import { and, asc, eq } from "drizzle-orm";
import {
	AddCommentSchema,
	DeleteCommentSchema,
	ListCommentsSchema,
	UpdateCommentSchema,
} from "../schemas/comments";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

interface CommentRow {
	id: string;
	body: string;
	created_at: number;
	updated_at: number;
	author_id: string;
	author_name: string;
	author_email: string;
}

async function getIssue(db: D1Database, issueId: string, workspaceId: string) {
	const orm = drizzle(db, { schema });
	return orm
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), eq(schema.issues.workspaceId, workspaceId)))
		.get();
}

export async function listComments(ctx: ServiceCtx, input: unknown): Promise<CommentRow[]> {
	const parsed = ListCommentsSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { issueId } = parsed.data;

	if (!(await getIssue(ctx.db, issueId, ctx.workspaceId))) {
		throw new NotFoundError("Issue not found");
	}

	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({
			id: schema.issueComments.id,
			body: schema.issueComments.body,
			// eslint-disable-next-line camelcase
			created_at: schema.issueComments.createdAt,
			// eslint-disable-next-line camelcase
			updated_at: schema.issueComments.updatedAt,
			// eslint-disable-next-line camelcase
			author_id: schema.users.id,
			// eslint-disable-next-line camelcase
			author_name: schema.users.name,
			// eslint-disable-next-line camelcase
			author_email: schema.users.email,
		})
		.from(schema.issueComments)
		.innerJoin(schema.users, eq(schema.issueComments.authorId, schema.users.id))
		.where(eq(schema.issueComments.issueId, issueId))
		.orderBy(asc(schema.issueComments.createdAt));

	return rows as CommentRow[];
}

export async function addComment(ctx: ServiceCtx, input: unknown): Promise<{ id: string }> {
	const parsed = AddCommentSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { issueId, body } = parsed.data;

	if (!(await getIssue(ctx.db, issueId, ctx.workspaceId))) {
		throw new NotFoundError("Issue not found");
	}

	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	const orm = drizzle(ctx.db, { schema });

	await orm.insert(schema.issueComments).values({
		id,
		issueId,
		authorId: ctx.userId,
		body,
		createdAt: now,
		updatedAt: now,
	});

	return { id };
}

export async function updateComment(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }> {
	const parsed = UpdateCommentSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { issueId, commentId, body } = parsed.data;

	if (!(await getIssue(ctx.db, issueId, ctx.workspaceId))) {
		throw new NotFoundError("Issue not found");
	}

	const orm = drizzle(ctx.db, { schema });
	const comment = await orm
		.select({ id: schema.issueComments.id, authorId: schema.issueComments.authorId })
		.from(schema.issueComments)
		.where(and(eq(schema.issueComments.id, commentId), eq(schema.issueComments.issueId, issueId)))
		.get();

	if (!comment) throw new NotFoundError("Comment not found");
	if (comment.authorId !== ctx.userId) throw new ForbiddenError("Forbidden");

	await orm
		.update(schema.issueComments)
		.set({ body, updatedAt: Math.floor(Date.now() / 1000) })
		.where(eq(schema.issueComments.id, commentId));

	return { ok: true };
}

export async function deleteComment(ctx: ServiceCtx, input: unknown): Promise<{ ok: true }> {
	const parsed = DeleteCommentSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const { issueId, commentId } = parsed.data;

	if (!(await getIssue(ctx.db, issueId, ctx.workspaceId))) {
		throw new NotFoundError("Issue not found");
	}

	const orm = drizzle(ctx.db, { schema });
	const comment = await orm
		.select({ id: schema.issueComments.id, authorId: schema.issueComments.authorId })
		.from(schema.issueComments)
		.where(and(eq(schema.issueComments.id, commentId), eq(schema.issueComments.issueId, issueId)))
		.get();

	if (!comment) throw new NotFoundError("Comment not found");

	const canDelete = comment.authorId === ctx.userId || ctx.role === "admin" || ctx.role === "owner";
	if (!canDelete) throw new ForbiddenError("Forbidden");

	await orm.delete(schema.issueComments).where(eq(schema.issueComments.id, commentId));

	return { ok: true };
}
