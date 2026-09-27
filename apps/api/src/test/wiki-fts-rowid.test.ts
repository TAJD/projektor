// PROJ-816: wiki_fts rows are keyed by wiki_pages.search_rowid, so a page's re-index
// deletes its FTS row by rowid (a direct lookup) rather than scanning the UNINDEXED
// page_id column across every tenant's pages.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServiceCtx } from "../services/types";
import { createWikiPage, updateWikiPage } from "../services/wiki";
import { seedFixture } from "./helpers";

async function ctxFor(): Promise<ServiceCtx> {
	const { workspace, user } = await seedFixture({ role: "owner" });
	return {
		db: env.DB,
		kv: env.KV,
		r2: env.R2,
		workspaceId: workspace.id,
		userId: user.id,
		role: "owner",
	};
}

async function plan(sql: string, ...params: unknown[]): Promise<string> {
	const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.bind(...params)
		.all<{ detail: string }>();
	return rows.results.map((r) => r.detail).join(" | ");
}

describe("PROJ-816: wiki_fts is keyed by the page's search_rowid", () => {
	it("re-indexing deletes by rowid — the plan is a rowid lookup, not a full-index scan", async () => {
		const fullScan = await plan("DELETE FROM wiki_fts WHERE page_id = ?", "x");
		const byRowid = await plan(
			"DELETE FROM wiki_fts WHERE rowid = (SELECT search_rowid FROM wiki_pages WHERE id = ? AND workspace_id = ?)",
			"x",
			"y"
		);
		// FTS5 reports its xBestIndex choice as "VIRTUAL TABLE INDEX <n>:<constraints>";
		// a rowid-equality lookup carries an '=' constraint, the page_id filter none.
		expect(fullScan).toMatch(/VIRTUAL TABLE INDEX \d+:(\s|$|\|)/);
		expect(byRowid).toMatch(/VIRTUAL TABLE INDEX \d+:=/);
	});

	it("each save keeps exactly one FTS row per page, under the page's search_rowid", async () => {
		const ctx = await ctxFor();
		const a = (await createWikiPage(ctx, { title: "Alpha", content: "one" })) as {
			id: string;
			slug: string;
		};
		const b = (await createWikiPage(ctx, { title: "Beta", content: "two" })) as {
			id: string;
			slug: string;
		};
		for (const content of ["three", "four", "five"]) {
			await updateWikiPage(ctx, a.slug, { content });
		}
		const rows = await env.DB.prepare(
			`SELECT f.page_id, f.content, f.rowid = p.search_rowid AS keyed
			 FROM wiki_fts f JOIN wiki_pages p ON p.id = f.page_id WHERE p.id IN (?, ?) ORDER BY f.page_id`
		)
			.bind(a.id, b.id)
			.all<{ page_id: string; content: string; keyed: number }>();
		const byPage = Object.fromEntries(rows.results.map((r) => [r.page_id, r]));
		expect(rows.results).toHaveLength(2);
		expect(byPage[a.id].content).toBe("five");
		expect(byPage[b.id].content).toBe("two");
		expect(rows.results.every((r) => r.keyed === 1)).toBe(true);
	});

	it("a page with no search_rowid yet (written outside the service) gets one on save", async () => {
		const ctx = await ctxFor();
		const page = (await createWikiPage(ctx, { title: "Legacy", content: "x" })) as {
			id: string;
			slug: string;
		};
		await env.DB.prepare("DELETE FROM wiki_fts WHERE page_id = ?").bind(page.id).run();
		await env.DB.prepare("UPDATE wiki_pages SET search_rowid = NULL WHERE id = ?")
			.bind(page.id)
			.run();
		await updateWikiPage(ctx, page.slug, { content: "y" });
		const row = await env.DB.prepare(
			"SELECT p.search_rowid AS r, (SELECT COUNT(*) FROM wiki_fts f WHERE f.rowid = p.search_rowid) AS n FROM wiki_pages p WHERE p.id = ?"
		)
			.bind(page.id)
			.first<{ r: number | null; n: number }>();
		expect(row?.r).not.toBeNull();
		expect(row?.n).toBe(1);
	});
});
