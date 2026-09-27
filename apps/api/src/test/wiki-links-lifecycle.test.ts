// PROJ-814: creating, renaming, restoring or purging a page re-resolves OTHER pages'
// [[Target]] links that match its title/slug, without those pages being re-saved.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServiceCtx } from "../services/types";
import { purgeExpiredWikiPages } from "../services/wiki";
import { authHeaders, seedFixture } from "./helpers";
import { resetRateLimits } from "./rate-limit-reset";

// PROJ-238: the test env's RATE_LIMIT_API_MAX is 5 req/window, and each test below fires
// more than that against one token — reset before every request.
async function fetchFresh(url: string, opts?: RequestInit): Promise<Response> {
	await resetRateLimits();
	return SELF.fetch(url, opts);
}

async function createPage(token: string, slug: string, title: string, content = "") {
	const res = await fetchFresh("http://localhost/api/wiki", {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify({ title, content }),
	});
	expect(res.status).toBe(201);
	return res.json() as Promise<{ id: string; slug: string }>;
}

async function updatePage(
	token: string,
	wsSlug: string,
	pageSlug: string,
	body: Record<string, unknown>
) {
	const res = await fetchFresh(`http://localhost/api/wiki/${pageSlug}`, {
		method: "PUT",
		headers: authHeaders(token, wsSlug),
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	return res.json();
}

async function deletePage(token: string, wsSlug: string, pageSlug: string) {
	const res = await fetchFresh(`http://localhost/api/wiki/${pageSlug}`, {
		method: "DELETE",
		headers: authHeaders(token, wsSlug),
	});
	expect(res.status).toBe(200);
}

async function undeletePage(token: string, wsSlug: string, pageId: string) {
	const res = await fetchFresh(`http://localhost/api/wiki/trash/${pageId}/undelete`, {
		method: "POST",
		headers: authHeaders(token, wsSlug),
	});
	expect(res.status).toBe(200);
}

async function brokenLinks(token: string, wsSlug: string) {
	const res = await fetchFresh("http://localhost/api/wiki/broken-links", {
		headers: authHeaders(token, wsSlug),
	});
	expect(res.status).toBe(200);
	return res.json() as Promise<Array<{ sourcePageId: string; targetTitle: string }>>;
}

async function backlinks(token: string, wsSlug: string, pageSlug: string) {
	const res = await fetchFresh(`http://localhost/api/wiki/${pageSlug}/backlinks`, {
		headers: authHeaders(token, wsSlug),
	});
	expect(res.status).toBe(200);
	return res.json() as Promise<Array<{ pageId: string; slug: string }>>;
}

describe("PROJ-814: lifecycle events re-resolve other pages' wiki links", () => {
	it("create: an unresolved link resolves once the matching page is created", async () => {
		const { workspace, token } = await seedFixture({ role: "owner" });
		const linker = await createPage(token, workspace.slug, "Linker", "See [[Onboarding]].");

		let broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id && l.targetTitle === "Onboarding")).toBe(
			true
		);

		const target = await createPage(token, workspace.slug, "Onboarding");

		broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id)).toBe(false);
		const back = await backlinks(token, workspace.slug, target.slug);
		expect(back.some((b) => b.pageId === linker.id)).toBe(true);
	});

	it("rename: a link to the old title/slug unresolves, and a rename onto the raw text resolves it", async () => {
		const { workspace, token } = await seedFixture({ role: "owner" });
		const target = await createPage(token, workspace.slug, "Foo");
		const linker = await createPage(token, workspace.slug, "Linker2", "See [[Foo]].");

		// Sanity: resolved at creation time (existing per-page resolution).
		expect(
			(await backlinks(token, workspace.slug, target.slug)).some((b) => b.pageId === linker.id)
		).toBe(true);

		// Rename the target away from "Foo" — the link's raw text no longer matches it.
		await updatePage(token, workspace.slug, target.slug, { title: "Bar" });

		let broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id && l.targetTitle === "Foo")).toBe(true);
		// slug is unchanged (only the title was renamed) — target.slug still resolves the page.
		expect(
			(await backlinks(token, workspace.slug, target.slug)).some((b) => b.pageId === linker.id)
		).toBe(false);

		// Rename a THIRD, unrelated page onto "Foo" — it should claim the now-broken link.
		const claimant = await createPage(token, workspace.slug, "Unrelated");
		await updatePage(token, workspace.slug, claimant.slug, { title: "Foo" });

		broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id)).toBe(false);
		expect(
			(await backlinks(token, workspace.slug, claimant.slug)).some((b) => b.pageId === linker.id)
		).toBe(true);
	});

	it("restore: a link waiting on a trashed page resolves once it's restored", async () => {
		const { workspace, token } = await seedFixture({ role: "owner" });
		const target = await createPage(token, workspace.slug, "Vault");
		await deletePage(token, workspace.slug, target.slug);

		// Written while "Vault" is trashed (treated as gone) — the link is unresolved.
		const linker = await createPage(token, workspace.slug, "Linker3", "See [[Vault]].");
		let broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id && l.targetTitle === "Vault")).toBe(
			true
		);

		await undeletePage(token, workspace.slug, target.id);

		broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id)).toBe(false);
		expect(
			(await backlinks(token, workspace.slug, target.slug)).some((b) => b.pageId === linker.id)
		).toBe(true);
	});

	it("trash: the link is reported broken but keeps its target, so restore brings it back", async () => {
		const { workspace, token } = await seedFixture({ role: "owner" });
		const target = await createPage(token, workspace.slug, "Doomed");
		const linker = await createPage(token, workspace.slug, "Linker4", "See [[Doomed]].");

		await deletePage(token, workspace.slug, target.slug);
		const broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id && l.targetTitle === "Doomed")).toBe(
			true
		);
		expect(await targetOf(linker.id)).toBe(target.id);

		await undeletePage(token, workspace.slug, target.id);
		expect(
			(await backlinks(token, workspace.slug, target.slug)).some((b) => b.pageId === linker.id)
		).toBe(true);
	});

	it("purge: links re-point to another live page with the same title, else unresolve", async () => {
		const { workspace, token, user } = await seedFixture({ role: "owner" });
		const first = await createPage(token, workspace.slug, "Twin");
		// Titles aren't unique (slugs are): make a second "Twin" by renaming.
		const second = await createPage(token, workspace.slug, "Twin two");
		await updatePage(token, workspace.slug, second.slug, { title: "Twin" });
		// Same-second creates would tie; make "first" unambiguously the oldest.
		await env.DB.prepare("UPDATE wiki_pages SET created_at = 1 WHERE id = ?").bind(first.id).run();
		const lone = await createPage(token, workspace.slug, "Lonely");
		const linker = await createPage(token, workspace.slug, "Linker5", "[[Twin]] [[Lonely]]");
		// Oldest page wins a duplicate title.
		expect(await targetsOf(linker.id)).toEqual([first.id, lone.id].sort());

		for (const p of [first, lone]) {
			await deletePage(token, workspace.slug, p.slug);
			await env.DB.prepare("UPDATE wiki_pages SET deleted_at = 1 WHERE id = ?").bind(p.id).run();
		}
		const ctx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId: workspace.id,
			userId: user.id,
			role: "owner",
		};
		await purgeExpiredWikiPages(ctx);
		const rows = await env.DB.prepare(
			"SELECT target_title AS t, target_page_id AS id FROM wiki_links WHERE source_page_id = ?"
		)
			.bind(linker.id)
			.all<{ t: string; id: string | null }>();
		const byTitle = Object.fromEntries(rows.results.map((r) => [r.t, r.id]));
		expect(byTitle).toEqual({ Twin: second.id, Lonely: null });
	});

	it("rename: a URL/slug link keeps its target when the title changes", async () => {
		const { workspace, token } = await seedFixture({ role: "owner" });
		const target = await createPage(token, workspace.slug, "Foo");
		const byUrl = await createPage(token, workspace.slug, "ByUrl", `[x](/wiki/${target.slug})`);
		const byTitle = await createPage(token, workspace.slug, "ByTitle", "[[Foo]]");
		await updatePage(token, workspace.slug, target.slug, { title: "Bar" });
		// The URL link still points at the page; the [[Foo]] title link no longer matches.
		expect(await targetOf(byUrl.id)).toBe(target.id);
		expect(await targetOf(byTitle.id)).toBeNull();
	});
});

async function targetOf(sourceId: string): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT target_page_id AS t FROM wiki_links WHERE source_page_id = ?"
	)
		.bind(sourceId)
		.first<{ t: string | null }>();
	return row?.t ?? null;
}

async function targetsOf(sourceId: string): Promise<Array<string | null>> {
	const rows = await env.DB.prepare(
		"SELECT target_page_id AS t FROM wiki_links WHERE source_page_id = ? ORDER BY target_page_id"
	)
		.bind(sourceId)
		.all<{ t: string | null }>();
	return rows.results.map((r) => r.t);
}
