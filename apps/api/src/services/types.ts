import type { HonoEnv, Role } from "@projektor/types";
import type { Context } from "hono";

export interface ServiceCtx {
	db: D1Database;
	kv: KVNamespace;
	r2: R2Bucket;
	workspaceId: string;
	userId: string;
	role?: Role;
}

export function ctxFromHono(c: Context<HonoEnv>): ServiceCtx {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };
	const role = c.get("role") as Role | undefined;
	return {
		db: c.env.DB,
		kv: c.env.KV,
		r2: c.env.R2,
		workspaceId: workspace.id,
		userId: user.id,
		role,
	};
}
