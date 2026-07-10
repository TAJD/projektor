import type { HonoEnv, Role } from "@projektor/types";
import type { Context } from "hono";

export interface ServiceCtx {
	db: D1Database;
	kv: KVNamespace;
	r2: R2Bucket;
	workspaceId: string;
	userId: string;
	role?: Role;
	// PROJ-328: which auth path authenticated this request ("human" = Cloudflare Access
	// JWT / dev bypass, "agent" = Bearer API token). See middleware/auth.ts.
	authKind?: "human" | "agent";
}

export function ctxFromHono(c: Context<HonoEnv>): ServiceCtx {
	const workspace = c.get("workspace") as { id: string };
	const user = c.get("user") as { id: string };
	const role = c.get("role") as Role | undefined;
	const authKind = c.get("authKind") as "human" | "agent" | undefined;
	return {
		db: c.env.DB,
		kv: c.env.KV,
		r2: c.env.R2,
		workspaceId: workspace.id,
		userId: user.id,
		role,
		authKind,
	};
}
