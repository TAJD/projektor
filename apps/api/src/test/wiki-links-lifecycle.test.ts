// PROJ-814: creating, renaming, restoring or purging a page re-resolves OTHER pages'
// [[Target]] links that match its title/slug, without those pages being re-saved.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

	it("trash: a link to a page just trashed becomes unresolved without editing the linking page", async () => {
		const { workspace, token } = await seedFixture({ role: "owner" });
		const target = await createPage(token, workspace.slug, "Doomed");
		const linker = await createPage(token, workspace.slug, "Linker4", "See [[Doomed]].");
		expect(
			(await backlinks(token, workspace.slug, target.slug)).some((b) => b.pageId === linker.id)
		).toBe(true);

		await deletePage(token, workspace.slug, target.slug);

		// list_broken_wiki_links already flags this via its "target page is trashed" EXISTS
		// check even without target_page_id being cleared, so assert the raw column too —
		// that's the part this ticket actually changes (clearIncomingLinkTargets now runs
		// at trash time, not just at purge time).
		const row = await env.DB.prepare(
			"SELECT target_page_id FROM wiki_links WHERE source_page_id = ?"
		)
			.bind(linker.id)
			.first<{ target_page_id: string | null }>();
		expect(row?.target_page_id).toBeNull();

		const broken = await brokenLinks(token, workspace.slug);
		expect(broken.some((l) => l.sourcePageId === linker.id && l.targetTitle === "Doomed")).toBe(
			true
		);
	});
});
