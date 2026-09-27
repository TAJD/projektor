// PROJ-815: backfillWikiLinks batches reads/writes, skips trashed pages, and is
// incremental/resumable via a cursor + page budget, with an updatedSince scope filter.

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, seedFixture } from "./helpers";

async function insertPage(
	workspaceId: string,
	userId: string,
	fields: Readonly<{
		id?: string;
		slug: string;
		title: string;
		content?: string;
		updatedAt?: number;
		deletedAt?: number | null;
	}>
) {
	const id = fields.id ?? crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content, parent_id,
		   created_by_id, updated_by_id, created_at, updated_at, deleted_at)
		 VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			workspaceId,
			fields.slug,
			fields.title,
			fields.content ?? "",
			userId,
			userId,
			now,
			fields.updatedAt ?? now,
			fields.deletedAt ?? null
		)
		.run();
	return id;
}

async function backfill(token: string, slug: string, body: Record<string, unknown> = {}) {
	const res = await SELF.fetch("http://localhost/api/wiki/backfill-links", {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	return res.json() as Promise<{
		processed: number;
		nextCursor: { updatedAt: number; id: string } | null;
	}>;
}

describe("PROJ-815: backfillWikiLinks batching, trash, cursor, updatedSince", () => {
	afterEach(() => vi.restoreAllMocks());

	it("skips trashed pages", async () => {
		const { workspace, user, token } = await seedFixture({ role: "owner" });
		const targetId = await insertPage(workspace.id, user.id, { slug: "target", title: "Target" });
		const trashedId = await insertPage(workspace.id, user.id, {
			slug: "trashed-linker",
			title: "Trashed Linker",
			content: "[[Target]]",
			deletedAt: Math.floor(Date.now() / 1000),
		});

		const result = await backfill(token, workspace.slug);
		expect(result.processed).toBe(1); // only "target" — the trashed page is skipped
		expect(result.nextCursor).toBeNull();

		const rows = await env.DB.prepare("SELECT * FROM wiki_links WHERE source_page_id = ?")
			.bind(trashedId)
			.all();
		expect(rows.results).toHaveLength(0);
		// sanity: the live page was still processed and produced no links of its own.
		const targetRows = await env.DB.prepare("SELECT * FROM wiki_links WHERE source_page_id = ?")
			.bind(targetId)
			.all();
		expect(targetRows.results).toHaveLength(0);
	});

	it("bounds D1 calls for 200 pages regardless of page count", async () => {
		const { workspace, user, token } = await seedFixture({ role: "owner" });
		for (let i = 0; i < 200; i++) {
			await insertPage(workspace.id, user.id, {
				slug: `page-${i}`,
				title: `Page ${i}`,
				content: i > 0 ? `[[Page ${i - 1}]]` : "",
			});
		}

		const selects: string[] = [];
		const origPrepare = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			if (/^select/i.test(q.trim())) selects.push(q);
			return origPrepare(q);
		});
		const batchSpy = vi.spyOn(env.DB, "batch");

		const result = await backfill(token, workspace.slug, { pageBudget: 200 });
		vi.restoreAllMocks();

		expect(result.processed).toBe(200);
		// One page-select query plus a handful of chunked title-resolution reads — not
		// one (or more) reads per page, which would scale to hundreds.
		// +2 constant: the PROJ-818 fold heal and the unhealed-title fallback query.
		expect(selects.length).toBeLessThanOrEqual(12);
		// Every page's DELETE+INSERT lands in exactly one db.batch() round trip for the
		// whole chunk, not one batch per page.
		// one link-write batch, plus at most one PROJ-818 fold-heal batch (constant, not per page)
		expect(batchSpy.mock.calls.length).toBeLessThanOrEqual(2);
	});

	it("a cursor resumes where the previous call stopped", async () => {
		const { workspace, user, token } = await seedFixture({ role: "owner" });
		const now = Math.floor(Date.now() / 1000);
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			ids.push(
				await insertPage(workspace.id, user.id, {
					slug: `p${i}`,
					title: `P${i}`,
					updatedAt: now + i,
				})
			);
		}

		const first = await backfill(token, workspace.slug, { pageBudget: 4 });
		expect(first.processed).toBe(4);
		expect(first.nextCursor).not.toBeNull();

		const second = await backfill(token, workspace.slug, {
			pageBudget: 4,
			cursor: first.nextCursor,
		});
		expect(second.processed).toBe(4);
		expect(second.nextCursor).not.toBeNull();

		const third = await backfill(token, workspace.slug, {
			pageBudget: 4,
			cursor: second.nextCursor,
		});
		expect(third.processed).toBe(2);
		expect(third.nextCursor).toBeNull();
	});

	it("updatedSince limits the scope to pages touched at/after that time", async () => {
		const { workspace, user, token } = await seedFixture({ role: "owner" });
		const now = Math.floor(Date.now() / 1000);
		await insertPage(workspace.id, user.id, { slug: "old", title: "Old", updatedAt: now - 1000 });
		await insertPage(workspace.id, user.id, { slug: "new", title: "New", updatedAt: now });

		const result = await backfill(token, workspace.slug, { updatedSince: now - 10 });
		expect(result.processed).toBe(1);
	});
});
