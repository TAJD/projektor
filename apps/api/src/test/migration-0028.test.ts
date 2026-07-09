import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import m0028 from "../../../../packages/db/migrations/0028_downgrade_viewer_grants.sql?raw";
import { seedMember, seedProject, seedUser, seedWorkspace } from "./helpers";

// PROJ-318: 0028 splits the 0027 all-projects backfill so a pre-existing workspace
// viewer keeps a read-only grant instead of being silently promoted to member.

function splitStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

async function runMigration0028() {
	for (const stmt of splitStatements(m0028)) {
		await env.DB.prepare(stmt).run();
	}
}

// Recreate the post-0027 backfill state for a fresh workspace: an 'all-projects'
// group granting `member` on every project, enrolling both members and viewers.
async function seed0027Backfill() {
	const ws = await seedWorkspace();
	const memberGroupId = `grp-allproj-${ws.id}`;
	const pX = await seedProject(ws.id, "X");
	const pY = await seedProject(ws.id, "Y");
	const viewer = await seedUser(`v-${crypto.randomUUID().slice(0, 8)}@example.com`);
	const member = await seedUser(`m-${crypto.randomUUID().slice(0, 8)}@example.com`);
	await seedMember(ws.id, viewer.id, "viewer");
	await seedMember(ws.id, member.id, "member");

	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		"INSERT INTO user_groups (id, workspace_id, name, description, created_at) VALUES (?, ?, 'all-projects', NULL, ?)"
	)
		.bind(memberGroupId, ws.id, now)
		.run();
	for (const p of [pX, pY]) {
		await env.DB.prepare(
			"INSERT INTO group_project_grants (group_id, project_id, role) VALUES (?, ?, 'member')"
		)
			.bind(memberGroupId, p.id)
			.run();
	}
	for (const u of [viewer, member]) {
		await env.DB.prepare(
			"INSERT INTO user_group_members (group_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)"
		)
			.bind(memberGroupId, u.id, u.id, now)
			.run();
	}
	return { ws, memberGroupId, viewersGroupId: `grp-allproj-viewers-${ws.id}`, viewer, member };
}

async function memberCount(groupId: string, userId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM user_group_members WHERE group_id = ? AND user_id = ?"
	)
		.bind(groupId, userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("0028 viewer-preserving migration", () => {
	let ctx: Awaited<ReturnType<typeof seed0027Backfill>>;

	beforeEach(async () => {
		ctx = await seed0027Backfill();
		await runMigration0028();
	});

	it("gives the viewer a read-only grant on the same projects", async () => {
		const grants = await env.DB.prepare("SELECT role FROM group_project_grants WHERE group_id = ?")
			.bind(ctx.viewersGroupId)
			.all<{ role: string }>();
		expect(grants.results).toHaveLength(2);
		expect(grants.results.every((g) => g.role === "viewer")).toBe(true);
	});

	it("moves the viewer out of the member group into the read-only group", async () => {
		expect(await memberCount(ctx.viewersGroupId, ctx.viewer.id)).toBe(1);
		expect(await memberCount(ctx.memberGroupId, ctx.viewer.id)).toBe(0);
	});

	it("leaves the member untouched (member group, member grant)", async () => {
		expect(await memberCount(ctx.memberGroupId, ctx.member.id)).toBe(1);
		expect(await memberCount(ctx.viewersGroupId, ctx.member.id)).toBe(0);
		const memberGrants = await env.DB.prepare(
			"SELECT DISTINCT role FROM group_project_grants WHERE group_id = ?"
		)
			.bind(ctx.memberGroupId)
			.all<{ role: string }>();
		expect(memberGrants.results.map((r) => r.role)).toEqual(["member"]);
	});

	it("is idempotent — re-running changes nothing", async () => {
		await runMigration0028();
		expect(await memberCount(ctx.viewersGroupId, ctx.viewer.id)).toBe(1);
		expect(await memberCount(ctx.memberGroupId, ctx.viewer.id)).toBe(0);
		const grants = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM group_project_grants WHERE group_id = ?"
		)
			.bind(ctx.viewersGroupId)
			.first<{ n: number }>();
		expect(grants?.n).toBe(2);
	});

	it("creates no viewers group for a workspace that has no viewers", async () => {
		const ws = await seedWorkspace();
		const groupId = `grp-allproj-${ws.id}`;
		const p = await seedProject(ws.id, "Z");
		const member = await seedUser(`m2-${crypto.randomUUID().slice(0, 8)}@example.com`);
		await seedMember(ws.id, member.id, "member");
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			"INSERT INTO user_groups (id, workspace_id, name, description, created_at) VALUES (?, ?, 'all-projects', NULL, ?)"
		)
			.bind(groupId, ws.id, now)
			.run();
		await env.DB.prepare(
			"INSERT INTO group_project_grants (group_id, project_id, role) VALUES (?, ?, 'member')"
		)
			.bind(groupId, p.id)
			.run();
		await env.DB.prepare(
			"INSERT INTO user_group_members (group_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)"
		)
			.bind(groupId, member.id, member.id, now)
			.run();

		await runMigration0028();

		const vg = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_groups WHERE id = ?")
			.bind(`grp-allproj-viewers-${ws.id}`)
			.first<{ n: number }>();
		expect(vg?.n).toBe(0);
	});
});
