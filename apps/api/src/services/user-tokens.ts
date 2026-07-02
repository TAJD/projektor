import { CreateUserTokenSchema } from "../schemas/user-tokens";
import { ForbiddenError, ValidationError } from "./errors";

// These handlers run pre-workspace-context (login/token minting are user-scoped,
// not workspace-scoped), so they take a narrower ctx than ServiceCtx.
export interface UserCtx {
	db: D1Database;
	userId: string;
}

async function hashToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function getUserWorkspaces(ctx: UserCtx) {
	const { results } = await ctx.db
		.prepare(
			`SELECT w.id, w.name, w.slug, wm.role
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = ?`
		)
		.bind(ctx.userId)
		.all();
	return results;
}

export async function createUserToken(ctx: UserCtx, raw: unknown) {
	const result = CreateUserTokenSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());

	const { name, workspaceId, scopes, expiresAt } = result.data;

	// PROJ-17: when minting a workspace-scoped token, the caller must be a member
	// of that workspace. Omitting workspaceId mints a user-scoped token (NULL in DB),
	// which is valid across all workspaces the user is a member of.
	if (workspaceId !== undefined) {
		const member = await ctx.db
			.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.bind(workspaceId, ctx.userId)
			.first();
		if (!member) throw new ForbiddenError();
	}

	const rawToken = crypto.randomUUID() + crypto.randomUUID();
	const hash = await hashToken(rawToken);

	await ctx.db
		.prepare(
			`INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			crypto.randomUUID(),
			workspaceId ?? null,
			ctx.userId,
			name,
			hash,
			JSON.stringify(scopes),
			expiresAt ?? null,
			Math.floor(Date.now() / 1000)
		)
		.run();

	return { token: rawToken };
}

export async function deleteUserToken(ctx: UserCtx, id: string) {
	await ctx.db
		.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
		.bind(id, ctx.userId)
		.run();
	return { ok: true };
}
