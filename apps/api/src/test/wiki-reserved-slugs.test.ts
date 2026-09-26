import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import m0060 from "../../../../packages/db/migrations/0060_wiki_reserved_slug_rename.sql?raw";
import { wikiRouter } from "../routes/wiki";
import { RESERVED_WIKI_SLUGS } from "../services/wiki";
import { authHeaders, seedFixture } from "./helpers";

// PROJ-811: every fixed first path segment under /api/wiki is matched before the /:slug
// catch-all, so a page with that slug could never load.
describe("reserved wiki slugs (PROJ-811)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "admin" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
	});

	it("reserves every fixed first segment registered on the wiki router", () => {
		const fixedSegments = new Set(
			wikiRouter.routes
				.map((r) => r.path.split("/")[1] ?? "")
				.filter((seg) => seg !== "" && !seg.startsWith(":") && seg !== "*")
		);
		expect(fixedSegments.size).toBeGreaterThan(5);
		const missing = [...fixedSegments].filter((seg) => !RESERVED_WIKI_SLUGS.has(seg));
		expect(missing).toEqual([]);
	});

	it("auto-slugs a reserved title with a -page suffix, and the page loads", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Search", content: "body" }),
		});
		expect(res.status).toBe(201);
		const page = (await res.json()) as { slug: string };
		expect(page.slug).toBe("search-page");

		const get = await SELF.fetch(`http://localhost/api/wiki/${page.slug}`, {
			headers: authHeaders(token, slug),
		});
		expect(get.status).toBe(200);
	});

	it("rejects choosing a reserved slug explicitly, on create and on rename", async () => {
		const created = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Bin", slug: "trash" }),
		});
		expect(created.status).toBe(400);

		const ok = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Plain" }),
		});
		const page = (await ok.json()) as { id: string };
		const renamed = await SELF.fetch(`http://localhost/api/wiki/${page.id}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "tree" }),
		});
		expect(renamed.status).toBe(400);
	});

	it("migration 0060 renames existing pages off reserved slugs, trashed ones included", async () => {
		const now = Math.floor(Date.now() / 1000);
		const insert = (pageSlug: string, deletedAt: number | null) => {
			const id = crypto.randomUUID();
			return {
				id,
				stmt: env.DB.prepare(
					`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content,
					 parent_id, created_by_id, updated_by_id, created_at, updated_at, deleted_at)
					 VALUES (?, ?, NULL, ?, ?, '', NULL, ?, ?, ?, ?, ?)`
				).bind(id, workspaceId, pageSlug, pageSlug, userId, userId, now, now, deletedAt),
			};
		};
		const search = insert("search", null);
		const exportPage = insert("export", null);
		const exportTaken = insert("export-page", null); // forces the second pass
		const trashed = insert("trash", now);
		await env.DB.batch([search.stmt, exportPage.stmt, exportTaken.stmt, trashed.stmt]);

		const statements = m0060
			.replace(/--[^\n]*/g, "")
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		for (const stmt of statements) await env.DB.prepare(stmt).run();

		const slugOf = async (id: string) =>
			(
				await env.DB.prepare("SELECT slug FROM wiki_pages WHERE id = ?").bind(id).first<{
					slug: string;
				}>()
			)?.slug;
		expect(await slugOf(search.id)).toBe("search-page");
		expect(await slugOf(exportTaken.id)).toBe("export-page");
		expect(await slugOf(exportPage.id)).toBe(
			`export-page-${exportPage.id.replace(/-/g, "").slice(0, 8)}`
		);
		expect(await slugOf(trashed.id)).toBe("trash-page");

		const reservedLeft = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM wiki_pages WHERE workspace_id = ? AND slug IN (${[
				...RESERVED_WIKI_SLUGS,
			]
				.map(() => "?")
				.join(",")})`
		)
			.bind(workspaceId, ...RESERVED_WIKI_SLUGS)
			.first<{ n: number }>();
		expect(reservedLeft?.n).toBe(0);
	});
});
