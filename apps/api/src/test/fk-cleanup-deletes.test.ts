// PROJ-923: delete paths for FK parents clean up their children explicitly, since D1
// Note: `PRAGMA foreign_keys = OFF` is a no-op on D1/Miniflare (verified: it still
// reads 1), so FK-backed children are also removed by the database's own cascade here —
// for those, these are end-state checks. What they prove is the cleanup the database
// can't do: FTS mirrors, share tokens, R2 objects and references without an FK.
// fk-cleanup.node.test.ts is the guard that the app-level cleanup exists.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deleteGroup } from "../services/groups";
import type { ServiceCtx } from "../services/types";
import { createWikiPage } from "../services/wiki";
import { deleteWorkspace, revokeToken } from "../services/workspaces";
import { seedFixture, seedGroupGrant, seedProject, seedTaskStatus } from "./helpers";

async function count(sql: string, ...params: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function ownerCtx() {
	const f = await seedFixture({ role: "owner" });
	const ctx: ServiceCtx = {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: f.workspace.id,
		userId: f.user.id,
		role: "owner",
	};
	return { ...f, ctx };
}

describe("PROJ-923: explicit cleanup on delete", () => {
	it("deleteGroup removes the group's members and grants", async () => {
		const { ctx, workspace, user } = await ownerCtx();
		const project = await seedProject(workspace.id, "GRP");
		const { groupId } = await seedGroupGrant(workspace.id, user.id, project.id);
		await deleteGroup(ctx, groupId);
		expect(
			await count("SELECT COUNT(*) AS n FROM user_group_members WHERE group_id = ?", groupId)
		).toBe(0);
		expect(
			await count("SELECT COUNT(*) AS n FROM group_project_grants WHERE group_id = ?", groupId)
		).toBe(0);
	});

	it("revokeToken nulls agent_sessions.token_id", async () => {
		const { ctx, workspace } = await ownerCtx();
		const tokenRow = await env.DB.prepare(
			"SELECT id FROM api_tokens WHERE workspace_id = ? LIMIT 1"
		)
			.bind(workspace.id)
			.first<{ id: string }>();
		const sessionId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO agent_sessions (id, workspace_id, token_id, name, status, started_at, last_heartbeat_at) VALUES (?, ?, ?, 'a', 'active', 0, 0)"
		)
			.bind(sessionId, workspace.id, tokenRow?.id)
			.run();
		await revokeToken(ctx, tokenRow?.id as string);
		const row = await env.DB.prepare("SELECT token_id AS t FROM agent_sessions WHERE id = ?")
			.bind(sessionId)
			.first<{ t: string | null }>();
		expect(row?.t).toBeNull();
	});

	it("deleteWorkspace leaves no row referencing the workspace", async () => {
		const { ctx, workspace, user } = await ownerCtx();
		await seedTaskStatus(workspace.id, { key: "doing" });
		const project = await seedProject(workspace.id, "TMP");
		await seedGroupGrant(workspace.id, user.id, project.id);
		await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id).run();
		const page = (await createWikiPage(ctx, { title: "Workspace page", content: "x" })) as {
			id: string;
		};

		await deleteWorkspace(ctx, workspace.slug, "some-other-default");

		const tables = [
			"workspace_members",
			"api_tokens",
			"task_statuses",
			"user_groups",
			"wiki_pages",
			"wiki_fts",
			"activity",
		];
		for (const t of tables) {
			expect(
				`${t}: ${await count(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id = ?`, workspace.id)}`
			).toBe(`${t}: 0`);
		}
		expect(await count("SELECT COUNT(*) AS n FROM wiki_revisions WHERE page_id = ?", page.id)).toBe(
			0
		);
		expect(await count("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?", workspace.id)).toBe(0);
	});
});
