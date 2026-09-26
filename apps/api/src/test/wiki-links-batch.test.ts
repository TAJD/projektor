// PROJ-858: saving a page resolves its slug links in a fixed number of queries,
// not 1–3 per link, and produces the same wiki_links rows as before.

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, seedFixture } from "./helpers";

describe("PROJ-858: batched slug link resolution on save", () => {
	afterEach(() => vi.restoreAllMocks());

	it("200 distinct slug links (direct, redirected, missing) resolve correctly in O(1) reads", async () => {
		const { workspace, user, token } = await seedFixture({ role: "owner" });
		const now = Math.floor(Date.now() / 1000);
		const insertPage = (id: string, slug: string, title: string, deletedAt: number | null = null) =>
			env.DB.prepare(
				`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content, parent_id,
				   created_by_id, updated_by_id, created_at, updated_at, deleted_at)
				 VALUES (?, ?, NULL, ?, ?, '', NULL, ?, ?, ?, ?, ?)`
			)
				.bind(id, workspace.id, slug, title, user.id, user.id, now, now, deletedAt)
				.run();

		// 80 pages linked by their current slug.
		const direct: string[] = [];
		for (let i = 0; i < 80; i++) {
			const id = crypto.randomUUID();
			direct.push(id);
			await insertPage(id, `direct-${i}`, `Direct ${i}`);
		}
		// 40 pages linked by an old slug (redirect) — 5 of them trashed, so unresolved.
		const redirected: string[] = [];
		for (let i = 0; i < 40; i++) {
			const id = crypto.randomUUID();
			redirected.push(id);
			await insertPage(id, `renamed-${i}`, `Renamed ${i}`, i < 5 ? now : null);
			await env.DB.prepare(
				"INSERT INTO wiki_redirects (id, workspace_id, old_slug, page_id, created_at) VALUES (?, ?, ?, ?, ?)"
			)
				.bind(crypto.randomUUID(), workspace.id, `old-${i}`, id, now)
				.run();
		}

		const links = [
			...Array.from({ length: 80 }, (_, i) => `[d${i}](/wiki/direct-${i})`),
			...Array.from({ length: 40 }, (_, i) => `[r${i}](/wiki/old-${i})`),
			...Array.from({ length: 80 }, (_, i) => `[m${i}](/wiki/missing-${i})`),
			// duplicates must not create extra rows or queries
			...Array.from({ length: 30 }, () => "[again](/wiki/direct-0)"),
		];

		const sqls: string[] = [];
		const orig = env.DB.prepare.bind(env.DB);
		vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
			sqls.push(q);
			return orig(q);
		});

		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, workspace.slug),
			body: JSON.stringify({ title: "Hub", content: links.join("\n") }),
		});
		expect(res.status).toBe(201);
		vi.restoreAllMocks();

		// Every read of wiki_pages / wiki_redirects during the save — slug checks, parent
		// lookups and link resolution together. Per-link resolution made this ~300.
		const wikiReads = sqls.filter(
			(q) => /^select/i.test(q.trim()) && /from "?wiki_(pages|redirects)"?/i.test(q)
		);
		expect(wikiReads.length).toBeLessThanOrEqual(12);

		const { id: hubId } = (await res.json()) as { id: string };
		const rows = await env.DB.prepare(
			"SELECT target_page_id, target_title FROM wiki_links WHERE source_page_id = ?"
		)
			.bind(hubId)
			.all<{ target_page_id: string | null; target_title: string }>();
		const resolvedIds = new Set(
			(rows.results ?? []).map((r) => r.target_page_id).filter((x): x is string => x !== null)
		);
		const unresolved = (rows.results ?? []).filter((r) => r.target_page_id === null);

		expect(resolvedIds).toEqual(new Set([...direct, ...redirected.slice(5)]));
		// 80 missing slugs + 5 redirects whose page is trashed.
		expect(unresolved).toHaveLength(85);
		expect((rows.results ?? []).length).toBe(80 + 35 + 85);
	});
});
