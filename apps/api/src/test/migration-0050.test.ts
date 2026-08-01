import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import m0050 from "../../../../packages/db/migrations/0050_wiki_slug_slash_backfill.sql?raw";
import { seedUser, seedWorkspace } from "./helpers";

// PROJ-517/512: runs the actual 0050 migration SQL against seeded rows, rather than
// hand-simulating what it does — the earlier test in wiki.test.ts only exercised the
// resulting redirect/slug shape, not the migration's own collision-handling logic
// (row-number disambiguation, EXISTS collision against a pre-existing slug, and the
// wiki_redirects ON CONFLICT upsert).

function splitStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

async function runMigration0050() {
	for (const stmt of splitStatements(m0050)) {
		await env.DB.prepare(stmt).run();
	}
}

async function insertPage(workspaceId: string, userId: string, slug: string, createdAt: number) {
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content,
		 parent_id, created_by_id, updated_by_id, created_at, updated_at)
		 VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?)`
	)
		.bind(id, workspaceId, slug, slug, "content", userId, userId, createdAt, createdAt)
		.run();
	return id;
}

describe("0050 wiki slug slash backfill", () => {
	let workspaceId: string;
	let userId: string;

	beforeEach(async () => {
		const ws = await seedWorkspace();
		const user = await seedUser(`u-${crypto.randomUUID().slice(0, 8)}@example.com`);
		workspaceId = ws.id;
		userId = user.id;
	});

	it("rewrites a simple slashy slug with no collision and leaves a redirect", async () => {
		const now = Math.floor(Date.now() / 1000);
		const pageId = await insertPage(workspaceId, userId, "docs/setup", now);

		await runMigration0050();

		const page = await env.DB.prepare("SELECT slug FROM wiki_pages WHERE id = ?")
			.bind(pageId)
			.first<{ slug: string }>();
		expect(page?.slug).toBe("docs-setup");

		const redirect = await env.DB.prepare(
			"SELECT page_id FROM wiki_redirects WHERE workspace_id = ? AND old_slug = ?"
		)
			.bind(workspaceId, "docs/setup")
			.first<{ page_id: string }>();
		expect(redirect?.page_id).toBe(pageId);
	});

	it("disambiguates two slashy slugs that rewrite to the same candidate with an id suffix", async () => {
		const now = Math.floor(Date.now() / 1000);
		const firstId = await insertPage(workspaceId, userId, "a/b/c", now);
		const secondId = await insertPage(workspaceId, userId, "a-b/c", now + 1);

		await runMigration0050();

		const rows = await env.DB.prepare("SELECT id, slug FROM wiki_pages WHERE id IN (?, ?)")
			.bind(firstId, secondId)
			.all<{ id: string; slug: string }>();
		const bySlug = new Map(rows.results.map((r) => [r.id, r.slug]));
		expect(bySlug.get(firstId)).toBe("a-b-c");
		expect(bySlug.get(secondId)).toBe(`a-b-c-${secondId.slice(0, 8)}`);
	});

	it("suffixes a slashy slug whose rewritten candidate collides with a pre-existing non-slashy page", async () => {
		const now = Math.floor(Date.now() / 1000);
		await insertPage(workspaceId, userId, "docs-faq", now);
		const slashyId = await insertPage(workspaceId, userId, "docs/faq", now + 1);

		await runMigration0050();

		const page = await env.DB.prepare("SELECT slug FROM wiki_pages WHERE id = ?")
			.bind(slashyId)
			.first<{ slug: string }>();
		expect(page?.slug).toBe(`docs-faq-${slashyId.slice(0, 8)}`);
	});

	it("upserts a pre-existing wiki_redirects row instead of aborting the migration on collision", async () => {
		const now = Math.floor(Date.now() / 1000);
		const otherPageId = await insertPage(workspaceId, userId, "unrelated", now - 2000);
		await env.DB.prepare(
			"INSERT INTO wiki_redirects (id, workspace_id, old_slug, page_id, created_at) VALUES (?, ?, ?, ?, ?)"
		)
			.bind(crypto.randomUUID(), workspaceId, "legacy/page", otherPageId, now - 1000)
			.run();

		const pageId = await insertPage(workspaceId, userId, "legacy/page", now);

		await expect(runMigration0050()).resolves.not.toThrow();

		const redirect = await env.DB.prepare(
			"SELECT page_id FROM wiki_redirects WHERE workspace_id = ? AND old_slug = ?"
		)
			.bind(workspaceId, "legacy/page")
			.first<{ page_id: string }>();
		expect(redirect?.page_id).toBe(pageId);
	});

	it("truncates an oversized rewritten candidate before appending the id suffix, staying under 200 chars", async () => {
		const now = Math.floor(Date.now() / 1000);
		const candidate = `${"b".repeat(120)}-${"c".repeat(120)}`; // 241 chars
		const slashy = `${"b".repeat(120)}/${"c".repeat(120)}`; // same length, collides once rewritten
		await insertPage(workspaceId, userId, candidate, now);
		const slashyId = await insertPage(workspaceId, userId, slashy, now + 1);

		await runMigration0050();

		const page = await env.DB.prepare("SELECT slug FROM wiki_pages WHERE id = ?")
			.bind(slashyId)
			.first<{ slug: string }>();
		expect(page?.slug).toBe(`${candidate.slice(0, 191)}-${slashyId.slice(0, 8)}`);
		expect(page?.slug?.length).toBe(200);
	});
});
