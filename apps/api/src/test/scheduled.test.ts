import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeAllWorkspacesExpiredWikiPages } from "../index";
import { authHeaders, seedFixture } from "./helpers";

// PROJ-496: the Workers Cron Trigger itself can't be exercised locally (no local cron
// firing in dev/test), so this calls the exported `purgeAllWorkspacesExpiredWikiPages`
// helper directly — the same function the `scheduled` handler in index.ts invokes on
// its daily fire — with the real test env, mirroring how the REST/MCP purge tests seed
// and backdate trash.
describe("scheduled wiki trash purge (PROJ-496)", () => {
	let token: string;
	let slug: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "admin" });
		token = fixture.token;
		slug = fixture.workspace.slug;
	});

	async function req(url: string, opts?: RequestInit) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return SELF.fetch(url, opts);
	}

	it("purges expired trash across every workspace, leaving unexpired trash untouched", async () => {
		const other = await seedFixture({ role: "admin" });

		const pageRes = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Scheduled Purge Page", content: "content" }),
		});
		const page = (await pageRes.json()) as { id: string; slug: string };
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		await env.DB.prepare("UPDATE wiki_pages SET deleted_at = ? WHERE id = ?")
			.bind(Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60, page.id)
			.run();

		const otherPageRes = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ title: "Scheduled Purge Other Page", content: "content" }),
		});
		const otherPage = (await otherPageRes.json()) as { id: string; slug: string };
		await req(`http://localhost/api/wiki/${otherPage.slug}`, {
			method: "DELETE",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		// Not backdated — still inside the retention window.

		await purgeAllWorkspacesExpiredWikiPages(env);

		expect(
			await env.DB.prepare("SELECT id FROM wiki_pages WHERE id = ?").bind(page.id).first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM wiki_pages WHERE id = ?").bind(otherPage.id).first()
		).not.toBeNull();
	});

	it("does not throw when a workspace has no expired trash", async () => {
		await expect(purgeAllWorkspacesExpiredWikiPages(env)).resolves.toBeUndefined();
	});
});
