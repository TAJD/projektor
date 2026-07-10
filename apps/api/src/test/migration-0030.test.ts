import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import m0030 from "../../../../packages/db/migrations/0030_backfill_review_timestamp.sql?raw";
import { seedIssue, seedProject, seedUser, seedWorkspace } from "./helpers";

// PROJ-328: 0030 backfills in_review_at (added by 0029) for issues that were already
// sitting in a review status before 0029 landed — see the migration file for why it's
// deliberately narrower than 0026's claimed_at/ready_at backfill.

function splitStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

async function runMigration0030() {
	for (const stmt of splitStatements(m0030)) {
		await env.DB.prepare(stmt).run();
	}
}

describe("0030 backfill in_review_at", () => {
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		const ws = await seedWorkspace();
		const user = await seedUser(`u-${crypto.randomUUID().slice(0, 8)}@example.com`);
		const project = await seedProject(ws.id);
		workspaceId = ws.id;
		projectId = project.id;
		userId = user.id;
	});

	it("backfills in_review_at from claimed_at for an issue currently in a review status", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "In review",
			status: "in_review",
		});
		await env.DB.prepare("UPDATE issues SET claimed_at = ? WHERE id = ?")
			.bind(now - 100, issue.id)
			.run();

		await runMigration0030();

		const row = await env.DB.prepare("SELECT in_review_at FROM issues WHERE id = ?")
			.bind(issue.id)
			.first<{ in_review_at: number | null }>();
		expect(row?.in_review_at).toBe(now - 100);
	});

	it("does not backfill a done issue that never carried a review status (no signal to guess from)", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "Closed without review",
			status: "done",
		});
		await env.DB.prepare("UPDATE issues SET claimed_at = ?, done_at = ? WHERE id = ?")
			.bind(now - 200, now, issue.id)
			.run();

		await runMigration0030();

		const row = await env.DB.prepare("SELECT in_review_at FROM issues WHERE id = ?")
			.bind(issue.id)
			.first<{ in_review_at: number | null }>();
		expect(row?.in_review_at).toBeNull();
	});

	it("does not overwrite an already-stamped in_review_at", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "Already stamped",
			status: "in_review",
		});
		await env.DB.prepare("UPDATE issues SET claimed_at = ?, in_review_at = ? WHERE id = ?")
			.bind(now - 300, now - 50, issue.id)
			.run();

		await runMigration0030();

		const row = await env.DB.prepare("SELECT in_review_at FROM issues WHERE id = ?")
			.bind(issue.id)
			.first<{ in_review_at: number | null }>();
		expect(row?.in_review_at).toBe(now - 50);
	});

	it("is idempotent — re-running changes nothing", async () => {
		const now = Math.floor(Date.now() / 1000);
		const issue = await seedIssue(workspaceId, projectId, userId, {
			title: "In review",
			status: "in_review",
		});
		await env.DB.prepare("UPDATE issues SET claimed_at = ? WHERE id = ?")
			.bind(now - 100, issue.id)
			.run();

		await runMigration0030();
		await runMigration0030();

		const row = await env.DB.prepare("SELECT in_review_at FROM issues WHERE id = ?")
			.bind(issue.id)
			.first<{ in_review_at: number | null }>();
		expect(row?.in_review_at).toBe(now - 100);
	});
});
