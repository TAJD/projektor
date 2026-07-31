import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { computeFreshness } from "../services/wiki-freshness";
import {
	authHeaders,
	seedFixture,
	seedGroupGrant,
	seedProject,
	seedWorkspaceRoles,
} from "./helpers";

type JsonRpcResult<T = unknown> = { jsonrpc: "2.0"; id: unknown; result: T };
type JsonRpcError = { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

async function mcpCall<T>(
	workspaceId: string,
	name: string,
	args: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	return res.json();
}

function isMcpError(r: JsonRpcResult | JsonRpcError): r is JsonRpcError {
	return "error" in r;
}

function mcpData<T>(r: JsonRpcResult<{ content: Array<{ text: string }> }> | JsonRpcError): T {
	if (isMcpError(r)) throw new Error(`MCP error: ${r.error.message}`);
	return JSON.parse(r.result.content[0].text) as T;
}

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Wiki API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
	});

	it("GET /api/wiki returns empty list initially", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("POST /api/wiki creates a page", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Getting Started", content: "# Welcome" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; slug: string };
		expect(body.slug).toBe("getting-started");
	});

	describe("canonical page url (PROJ-307)", () => {
		it("create/get/update/list/tree all expose a resolvable url", async () => {
			const createRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ title: "Weekly Updates", content: "index" }),
			});
			const created = (await createRes.json()) as { url: string };
			expect(created.url).toBe("/wiki/weekly-updates");

			const getRes = await SELF.fetch("http://localhost/api/wiki/weekly-updates", {
				headers: authHeaders(token, slug),
			});
			const fetched = (await getRes.json()) as { url: string };
			expect(fetched.url).toBe("/wiki/weekly-updates");

			const updateRes = await SELF.fetch("http://localhost/api/wiki/weekly-updates", {
				method: "PUT",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ content: "index v2" }),
			});
			const updated = (await updateRes.json()) as { url: string };
			expect(updated.url).toBe("/wiki/weekly-updates");

			const listRes = await SELF.fetch("http://localhost/api/wiki", {
				headers: authHeaders(token, slug),
			});
			const list = (await listRes.json()) as Array<{ slug: string; url: string }>;
			expect(list.find((p) => p.slug === "weekly-updates")?.url).toBe("/wiki/weekly-updates");

			const treeRes = await SELF.fetch("http://localhost/api/wiki/tree", {
				headers: authHeaders(token, slug),
			});
			const tree = (await treeRes.json()) as Array<{ slug: string; url: string }>;
			expect(tree.find((p) => p.slug === "weekly-updates")?.url).toBe("/wiki/weekly-updates");
		});

		it("does not include projectId in the url when the page is scoped to a project (slugs are workspace-unique, PROJ-483)", async () => {
			const project = await seedProject(workspaceId);
			await seedGroupGrant(workspaceId, userId, project.id);
			const createRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ title: "Project Notes", content: "notes", projectId: project.id }),
			});
			const created = (await createRes.json()) as { url: string };
			expect(created.url).toBe("/wiki/project-notes");
		});
	});

	it("PROJ-389: another workspace's owner cannot create a wiki page in this project", async () => {
		const project = await seedProject(workspaceId);
		const otherOwner = await seedFixture({ role: "owner" });
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(otherOwner.token, otherOwner.workspace.slug),
			body: JSON.stringify({ title: "Cross ws page", content: "x", projectId: project.id }),
		});
		expect(res.status).toBe(404);
	});

	it("GET /api/wiki/:slug retrieves a page by slug", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Architecture", content: "## System design" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/architecture", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const page = (await res.json()) as { title: string; content: string };
		expect(page.title).toBe("Architecture");
		expect(page.content).toBe("## System design");
	});

	it("GET /api/wiki/:slug returns 404 for unknown slug", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki/does-not-exist", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("PUT /api/wiki/:slug updates content and saves a revision", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Versioned", content: "v1 content" }),
		});

		const updateRes = await SELF.fetch("http://localhost/api/wiki/versioned", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Versioned", content: "v2 content" }),
		});
		expect(updateRes.status).toBe(200);

		const pageRes = await SELF.fetch("http://localhost/api/wiki/versioned", {
			headers: authHeaders(token, slug),
		});
		const page = (await pageRes.json()) as { content: string };
		expect(page.content).toBe("v2 content");

		const revRes = await SELF.fetch("http://localhost/api/wiki/versioned/revisions", {
			headers: authHeaders(token, slug),
		});
		const revisions = (await revRes.json()) as unknown[];
		expect(revisions).toHaveLength(1);
	});

	it("GET /api/wiki/search finds pages by keyword", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Deployment Guide", content: "Use wrangler to deploy" }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Onboarding", content: "Welcome to the team" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=wrangler", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Deployment Guide");
	});

	// PROJ-489 (R7): a page with no verify_interval/status frontmatter signal at all gets
	// `freshness: null` — never fabricated. (R7 landed; full freshness behavior is
	// exercised in the "Wiki freshness model (PROJ-489)" describe block below.)
	it("GET /api/wiki/search returns freshness: null for a page with no verification signal", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Freshness Placeholder Page", content: "wrangler" }),
		});
		const res = await SELF.fetch("http://localhost/api/wiki/search?q=wrangler", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ freshness: unknown }>;
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) expect(r.freshness).toBeNull();
	});

	// PROJ-513: `type` is freeform (per the PRD) — an arbitrary value like "guide" is a
	// valid filter, just one that (correctly) matches nothing here. `status` stays a
	// closed enum, so an unrecognized value there is still rejected.
	it("GET /api/wiki/search accepts an arbitrary type filter but rejects an unknown status (PROJ-513)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Noop Filter Page", content: "wrangler" }),
		});
		const okRes = await SELF.fetch("http://localhost/api/wiki/search?q=wrangler&type=guide", {
			headers: authHeaders(token, slug),
		});
		expect(okRes.status).toBe(200);
		const badStatusRes = await SELF.fetch(
			"http://localhost/api/wiki/search?q=wrangler&status=fresh",
			{ headers: authHeaders(token, slug) }
		);
		expect(badStatusRes.status).toBe(400);
	});

	it("accepts a custom slug", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Home", slug: "home", content: "Root page" }),
		});
		const body = (await res.json()) as { slug: string };
		expect(body.slug).toBe("home");
	});

	// --- canonical behavior parity tests ---

	it("GET /api/wiki?parentId= filters to children of that page (PROJ-244)", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Parent Page", content: "root" }),
		});
		const parent = (await parentRes.json()) as { id: string };

		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Child Page", content: "child", parentId: parent.id }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Unrelated Page", content: "sibling" }),
		});

		const res = await SELF.fetch(`http://localhost/api/wiki?parentId=${parent.id}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const pages = (await res.json()) as Array<{ title: string }>;
		expect(pages).toHaveLength(1);
		expect(pages[0].title).toBe("Child Page");
	});

	it("GET /api/wiki returns ALL pages regardless of parent hierarchy", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Parent Page", content: "root" }),
		});
		const parent = (await parentRes.json()) as { id: string; slug: string };

		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Child Page", content: "child", parentId: parent.id }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki", {
			headers: authHeaders(token, slug),
		});
		const pages = (await res.json()) as unknown[];
		expect(pages).toHaveLength(2);
	});

	it("GET /api/wiki/search with no query returns empty array", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Some Page", content: "content" }),
		});
		const res = await SELF.fetch("http://localhost/api/wiki/search", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	// PROJ-486: replaces the old "first 250 chars" excerpt with an FTS5 snippet()
	// that is anchored to the actual match and highlighted with ** markers.
	it("GET /api/wiki/search snippet is match-anchored and highlighted", async () => {
		const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ".repeat(
			20
		);
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Deep Match Page",
				content: `${filler} needle-term ${filler}`,
			}),
		});
		const res = await SELF.fetch("http://localhost/api/wiki/search?q=needle-term", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ excerpt: string }>;
		expect(results).toHaveLength(1);
		// The match is buried deep in a long page; a static first-250-chars excerpt
		// would never contain it, but a match-anchored snippet does.
		expect(results[0].excerpt).toContain("needle");
		expect(results[0].excerpt).toContain("**");
	});

	// PROJ-486: BM25 ranking with a title-weight boost — a query matching only the
	// title of one page should rank it above a page where the term only appears deep
	// in a long body.
	it("GET /api/wiki/search ranks a title match above a buried body match", async () => {
		const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ".repeat(
			20
		);
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Unrelated Page",
				content: `${filler} zylophone ${filler}`,
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Zylophone Guide", content: "short body, no repeat term" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=zylophone", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(2);
		expect(results[0].title).toBe("Zylophone Guide");
	});

	it("GET /api/wiki/search supports limit/offset pagination", async () => {
		for (let i = 0; i < 3; i++) {
			await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ title: `Paginated Page ${i}`, content: "shared-search-term" }),
			});
		}
		const page1 = await SELF.fetch(
			"http://localhost/api/wiki/search?q=shared-search-term&limit=2",
			{
				headers: authHeaders(token, slug),
			}
		);
		const page1Results = (await page1.json()) as Array<{ id: string }>;
		expect(page1Results).toHaveLength(2);

		const page2 = await SELF.fetch(
			"http://localhost/api/wiki/search?q=shared-search-term&limit=2&offset=2",
			{ headers: authHeaders(token, slug) }
		);
		const page2Results = (await page2.json()) as Array<{ id: string }>;
		expect(page2Results).toHaveLength(1);
		expect(page2Results.map((r) => r.id)).not.toContain(page1Results[0].id);
		expect(page2Results.map((r) => r.id)).not.toContain(page1Results[1].id);
	});

	it("GET /api/wiki/search paginates deterministically when results tie in rank", async () => {
		// All three pages below match equally (same term, same content shape), so bm25()
		// alone ties -- pagination must fall back to a stable tiebreaker (page id) rather
		// than duplicating or dropping rows across pages. Distinct titles avoid PROJ-483
		// slug-collision 409s; the rate_limit reset avoids tripping the 5-req/window cap
		// (RATE_LIMIT_API_MAX) across the create + fetch calls below.
		for (let i = 0; i < 3; i++) {
			const createRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({
					title: `Tie Rank Page ${i}`,
					content: "tie-rank-search-term",
				}),
			});
			expect(createRes.status).toBe(201);
		}
		await env.DB.prepare("DELETE FROM rate_limit").run();

		const fetchAll = () =>
			SELF.fetch("http://localhost/api/wiki/search?q=tie-rank-search-term&limit=2", {
				headers: authHeaders(token, slug),
			}).then((r) => r.json() as Promise<Array<{ id: string }>>);

		const first = await fetchAll();
		await env.DB.prepare("DELETE FROM rate_limit").run();
		const second = await fetchAll();
		expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));

		await env.DB.prepare("DELETE FROM rate_limit").run();
		const page2 = await SELF.fetch(
			"http://localhost/api/wiki/search?q=tie-rank-search-term&limit=2&offset=2",
			{ headers: authHeaders(token, slug) }
		);
		const page2Results = (await page2.json()) as Array<{ id: string }>;
		const allIds = [...first.map((r) => r.id), ...page2Results.map((r) => r.id)];
		expect(new Set(allIds).size).toBe(allIds.length);
		expect(allIds).toHaveLength(3);
	});

	it("GET /api/wiki/search updatedSince filters out pages updated before the cutoff", async () => {
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Stale Match Page", content: "freshness-cutoff-term" }),
		});
		const created = (await createRes.json()) as { id: string };
		const pageRow = await env.DB.prepare("SELECT updated_at FROM wiki_pages WHERE id = ?")
			.bind(created.id)
			.first<{ updated_at: number }>();
		const cutoff = (pageRow?.updated_at ?? 0) + 1000;

		const res = await SELF.fetch(
			`http://localhost/api/wiki/search?q=freshness-cutoff-term&updatedSince=${cutoff}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(await res.json()).toEqual([]);

		const resAll = await SELF.fetch("http://localhost/api/wiki/search?q=freshness-cutoff-term", {
			headers: authHeaders(token, slug),
		});
		const allResults = (await resAll.json()) as Array<{ id: string }>;
		expect(allResults).toHaveLength(1);
	});

	it("GET /api/wiki/search never returns another workspace's pages", async () => {
		const other = await seedFixture();
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ title: "Other Workspace Page", content: "cross-tenant-term" }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "This Workspace Page", content: "cross-tenant-term" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=cross-tenant-term", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("This Workspace Page");
	});

	// PROJ-486: the wiki_fts mirror table must track create/update/delete of wiki_pages.
	describe("wiki_fts index stays in sync", () => {
		it("a newly created page is searchable immediately", async () => {
			await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ title: "Sync Create Page", content: "sync-create-term" }),
			});
			const res = await SELF.fetch("http://localhost/api/wiki/search?q=sync-create-term", {
				headers: authHeaders(token, slug),
			});
			expect(await res.json()).toHaveLength(1);
		});

		it("an updated page's new content becomes searchable and old content stops matching", async () => {
			const createRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ title: "Sync Update Page", content: "before-update-term" }),
			});
			const created = (await createRes.json()) as { slug: string };

			await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
				method: "PUT",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ content: "after-update-term" }),
			});

			const oldRes = await SELF.fetch("http://localhost/api/wiki/search?q=before-update-term", {
				headers: authHeaders(token, slug),
			});
			expect(await oldRes.json()).toEqual([]);

			const newRes = await SELF.fetch("http://localhost/api/wiki/search?q=after-update-term", {
				headers: authHeaders(token, slug),
			});
			expect(await newRes.json()).toHaveLength(1);
		});

		it("a deleted page is no longer searchable", async () => {
			// Deleting a workspace-level page requires admin/owner (services/wiki.ts).
			const owner = await seedFixture({ role: "owner" });
			const createRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(owner.token, owner.workspace.slug),
				body: JSON.stringify({ title: "Sync Delete Page", content: "sync-delete-term" }),
			});
			const created = (await createRes.json()) as { slug: string };

			await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
				method: "DELETE",
				headers: authHeaders(owner.token, owner.workspace.slug),
			});

			const res = await SELF.fetch("http://localhost/api/wiki/search?q=sync-delete-term", {
				headers: authHeaders(owner.token, owner.workspace.slug),
			});
			expect(await res.json()).toEqual([]);
		});

		it("a cascade-deleted subtree's pages are no longer searchable", async () => {
			const owner = await seedFixture({ role: "owner" });
			const parentRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(owner.token, owner.workspace.slug),
				body: JSON.stringify({ title: "Sync Cascade Parent", content: "root" }),
			});
			const parent = (await parentRes.json()) as { id: string; slug: string };
			await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(owner.token, owner.workspace.slug),
				body: JSON.stringify({
					title: "Sync Cascade Child",
					content: "sync-cascade-term",
					parentId: parent.id,
				}),
			});

			await SELF.fetch(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
				method: "DELETE",
				headers: authHeaders(owner.token, owner.workspace.slug),
			});

			const res = await SELF.fetch("http://localhost/api/wiki/search?q=sync-cascade-term", {
				headers: authHeaders(owner.token, owner.workspace.slug),
			});
			expect(await res.json()).toEqual([]);
		});
	});

	it("PUT /api/wiki/:slug title-only update does not create a revision", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Original Title", content: "body text" }),
		});

		await SELF.fetch("http://localhost/api/wiki/original-title", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Renamed Title" }),
		});

		const revRes = await SELF.fetch("http://localhost/api/wiki/original-title/revisions", {
			headers: authHeaders(token, slug),
		});
		const revisions = (await revRes.json()) as unknown[];
		expect(revisions).toHaveLength(0);
	});

	it("POST /api/wiki returns 400 for invalid input", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("project-scoped pages are isolated from workspace-level list", async () => {
		const { env } = await import("cloudflare:test");
		const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
			.bind(slug)
			.first<{ id: string }>();
		const project = await seedProject(ws!.id, "WIKI");
		await seedGroupGrant(ws!.id, userId, project.id);

		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Project Page", content: "scoped", projectId: project.id }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Workspace Page", content: "global" }),
		});

		const projectRes = await SELF.fetch(`http://localhost/api/wiki?projectId=${project.id}`, {
			headers: authHeaders(token, slug),
		});
		const projectPages = (await projectRes.json()) as Array<{ title: string }>;
		expect(projectPages).toHaveLength(1);
		expect(projectPages[0].title).toBe("Project Page");

		const allRes = await SELF.fetch("http://localhost/api/wiki", {
			headers: authHeaders(token, slug),
		});
		const allPages = (await allRes.json()) as unknown[];
		expect(allPages).toHaveLength(2);
	});

	it("POST /api/wiki stores projectId and GET returns it", async () => {
		const { env } = await import("cloudflare:test");
		const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
			.bind(slug)
			.first<{ id: string }>();
		const project = await seedProject(ws!.id, "P2");
		await seedGroupGrant(ws!.id, userId, project.id);

		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Scoped Doc", content: "content", projectId: project.id }),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { slug: string; projectId: string | null };
		expect(created.projectId).toBe(project.id);

		const getRes = await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await getRes.json()) as { project_id: string | null };
		expect(page.project_id).toBe(project.id);
	});

	it("POST /api/wiki creates a nested page with parentId", async () => {
		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Parent", content: "parent content" }),
		});
		expect(parentRes.status).toBe(201);
		const parent = (await parentRes.json()) as { id: string; slug: string };

		const childRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Child", content: "child content", parentId: parent.id }),
		});
		expect(childRes.status).toBe(201);
		const child = (await childRes.json()) as { id: string; slug: string };

		const getRes = await SELF.fetch(`http://localhost/api/wiki/${child.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await getRes.json()) as { parent_id: string };
		expect(page.parent_id).toBe(parent.id);
	});

	it("POST /api/wiki rejects when max nesting depth (5) is exceeded", async () => {
		let parentId: string | null = null;
		// Create 5 levels deep (root → L1 → L2 → L3 → L4 → L5)
		for (let i = 0; i < 5; i++) {
			const body: Record<string, unknown> = { title: `Level ${i}`, content: "" };
			if (parentId) body.parentId = parentId;
			const res = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(201);
			const created = (await res.json()) as { id: string };
			parentId = created.id;
		}

		// Reset rate limit so the validation check (not the limiter) fires on the 6th request.
		await env.DB.prepare("DELETE FROM rate_limit").run();

		// Level 6 must be rejected (parent is at depth 5 → child would be depth 6)
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Too deep", content: "", parentId }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { formErrors: string[] } };
		expect(body.error.formErrors[0]).toMatch(/Maximum wiki nesting depth/);
	});

	it("GET /api/wiki/tree returns nested structure", async () => {
		const rootRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Root", content: "" }),
		});
		const root = (await rootRes.json()) as { id: string };

		const childRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Child", content: "", parentId: root.id }),
		});
		const child = (await childRes.json()) as { id: string };

		const treeRes = await SELF.fetch("http://localhost/api/wiki/tree", {
			headers: authHeaders(token, slug),
		});
		expect(treeRes.status).toBe(200);
		const tree = (await treeRes.json()) as Array<{
			id: string;
			children: Array<{ id: string; children: unknown[] }>;
		}>;
		const rootNode = tree.find((n) => n.id === root.id);
		expect(rootNode).toBeDefined();
		expect(rootNode!.children).toHaveLength(1);
		expect(rootNode!.children[0].id).toBe(child.id);
		expect(rootNode!.children[0].children).toHaveLength(0);
	});

	it("PUT /api/wiki/:slug reparents a page via parentId", async () => {
		const aRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Page A", content: "a" }),
		});
		const a = (await aRes.json()) as { id: string; slug: string };

		const bRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Page B", content: "b" }),
		});
		const b = (await bRes.json()) as { slug: string };

		// Reparent B under A
		const updateRes = await SELF.fetch(`http://localhost/api/wiki/${b.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ parentId: a.id }),
		});
		expect(updateRes.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/wiki/${b.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await getRes.json()) as { parent_id: string };
		expect(page.parent_id).toBe(a.id);
	});

	it("DELETE /api/wiki/:slug (default) promotes children to the deleted page's parent (PROJ-238)", async () => {
		const owner = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(owner.token, owner.workspace.slug);

		const grandparentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Grandparent", content: "" }),
		});
		const grandparent = (await grandparentRes.json()) as { id: string };

		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Parent To Delete", content: "", parentId: grandparent.id }),
		});
		const parent = (await parentRes.json()) as { id: string; slug: string };

		const childRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Child", content: "", parentId: parent.id }),
		});
		const child = (await childRes.json()) as { id: string; slug: string };

		const delRes = await SELF.fetch(`http://localhost/api/wiki/${parent.slug}`, {
			method: "DELETE",
			headers: ownerHeaders,
		});
		expect(delRes.status).toBe(200);
		expect(await delRes.json()).toEqual({ ok: true, deletedCount: 1, linkedByCount: 0 });

		const childPageRes = await SELF.fetch(`http://localhost/api/wiki/${child.slug}`, {
			headers: ownerHeaders,
		});
		const childPage = (await childPageRes.json()) as { parent_id: string };
		expect(childPage.parent_id).toBe(grandparent.id);
	});

	it("DELETE /api/wiki/:slug?cascade=true removes the page and its whole subtree", async () => {
		const owner = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(owner.token, owner.workspace.slug);

		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Cascade Parent", content: "" }),
		});
		const parent = (await parentRes.json()) as { id: string; slug: string };

		const childRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Cascade Child", content: "", parentId: parent.id }),
		});
		const child = (await childRes.json()) as { id: string; slug: string };

		const grandchildRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Cascade Grandchild", content: "", parentId: child.id }),
		});
		const grandchild = (await grandchildRes.json()) as { slug: string };

		const delRes = await SELF.fetch(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: ownerHeaders,
		});
		expect(delRes.status).toBe(200);
		expect(await delRes.json()).toEqual({ ok: true, deletedCount: 3, linkedByCount: 0 });

		await env.DB.prepare("DELETE FROM rate_limit").run();
		for (const s of [parent.slug, child.slug, grandchild.slug]) {
			const res = await SELF.fetch(`http://localhost/api/wiki/${s}`, {
				headers: ownerHeaders,
			});
			expect(res.status).toBe(404);
		}
	});

	async function uploadFileToPage(token: string, slug: string, pageId: string) {
		const form = new FormData();
		form.append("file", new File(["attachment content"], "doc.txt", { type: "text/plain" }));
		form.append("entityType", "wiki_page");
		form.append("entityId", pageId);
		const res = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		const { id } = (await res.json()) as { id: string };
		const row = await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?")
			.bind(id)
			.first<{ r2_key: string }>();
		return { attachmentId: id, r2Key: row!.r2_key };
	}

	it("DELETE /api/wiki/:slug (default) removes the R2 object for a file attached to the page (PROJ-426)", async () => {
		const owner = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(owner.token, owner.workspace.slug);

		const pageRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Page With File", content: "" }),
		});
		const page = (await pageRes.json()) as { id: string; slug: string };

		const { attachmentId, r2Key } = await uploadFileToPage(
			owner.token,
			owner.workspace.slug,
			page.id
		);
		expect(await env.R2.get(r2Key)).not.toBeNull();

		const delRes = await SELF.fetch(`http://localhost/api/wiki/${page.slug}`, {
			method: "DELETE",
			headers: ownerHeaders,
		});
		expect(delRes.status).toBe(200);

		expect(await env.R2.get(r2Key)).toBeNull();
		const row = await env.DB.prepare("SELECT id FROM attachments WHERE id = ?")
			.bind(attachmentId)
			.first();
		expect(row).toBeNull();
	});

	it("DELETE /api/wiki/:slug?cascade=true removes R2 objects for files attached across the subtree (PROJ-426)", async () => {
		const owner = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(owner.token, owner.workspace.slug);

		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Cascade Parent With File", content: "" }),
		});
		const parent = (await parentRes.json()) as { id: string; slug: string };

		const childRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ title: "Cascade Child With File", content: "", parentId: parent.id }),
		});
		const child = (await childRes.json()) as { id: string; slug: string };

		const parentFile = await uploadFileToPage(owner.token, owner.workspace.slug, parent.id);
		const childFile = await uploadFileToPage(owner.token, owner.workspace.slug, child.id);
		expect(await env.R2.get(parentFile.r2Key)).not.toBeNull();
		expect(await env.R2.get(childFile.r2Key)).not.toBeNull();

		const delRes = await SELF.fetch(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: ownerHeaders,
		});
		expect(delRes.status).toBe(200);

		expect(await env.R2.get(parentFile.r2Key)).toBeNull();
		expect(await env.R2.get(childFile.r2Key)).toBeNull();
	});

	it("DELETE /api/wiki/:slug returns 403 for viewer role", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Protected Page", content: "secret" }),
		});

		const { env } = await import("cloudflare:test");
		const { seedUser, seedMember, seedToken } = await import("./helpers");
		const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
			.bind(slug)
			.first<{ id: string }>();
		const viewerUser = await seedUser(`viewer-wiki-${crypto.randomUUID().slice(0, 8)}@example.com`);
		await seedMember(ws!.id, viewerUser.id, "viewer");
		const viewerToken = await seedToken(ws!.id, viewerUser.id);

		const delRes = await SELF.fetch("http://localhost/api/wiki/protected-page", {
			method: "DELETE",
			headers: authHeaders(viewerToken, slug),
		});
		expect(delRes.status).toBe(403);
	});
});

describe("Wiki role guards", () => {
	it("viewer cannot create a wiki page (403)", async () => {
		const roles = await seedWorkspaceRoles();

		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ title: "Viewer Page", content: "test" }),
		});
		expect(res.status).toBe(403);
	});

	it("viewer cannot update a wiki page (403)", async () => {
		const roles = await seedWorkspaceRoles();

		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ title: "Member Page", content: "original" }),
		});
		const { slug: pageSlug } = (await createRes.json()) as { slug: string };

		const updateRes = await SELF.fetch(`http://localhost/api/wiki/${pageSlug}`, {
			method: "PUT",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({ content: "hacked" }),
		});
		expect(updateRes.status).toBe(403);
	});

	it("member cannot delete a wiki page (403)", async () => {
		const roles = await seedWorkspaceRoles();

		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ title: "Member Deletable", content: "content" }),
		});
		const { slug: pageSlug } = (await createRes.json()) as { slug: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/wiki/${pageSlug}`, {
			method: "DELETE",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
		});
		expect(deleteRes.status).toBe(403);
	});

	it("admin can delete a wiki page", async () => {
		const roles = await seedWorkspaceRoles();

		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(roles.member.token, roles.workspace.slug),
			body: JSON.stringify({ title: "Admin Target", content: "content" }),
		});
		const { slug: pageSlug } = (await createRes.json()) as { slug: string };

		const deleteRes = await SELF.fetch(`http://localhost/api/wiki/${pageSlug}`, {
			method: "DELETE",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
		});
		expect(deleteRes.status).toBe(200);
	});
});

// PROJ-483: slug uniqueness + rename redirects
describe("Wiki slug uniqueness and redirects (PROJ-483)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	it("POST /api/wiki rejects a title that slugifies to an existing page's slug (409)", async () => {
		const first = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Operations", content: "v1" }),
		});
		expect(first.status).toBe(201);

		const second = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Operations", content: "v2" }),
		});
		expect(second.status).toBe(409);
	});

	it("POST /api/wiki rejects an explicit slug that collides with an existing page (409)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Operations", content: "v1" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Ops Handbook", slug: "operations", content: "v2" }),
		});
		expect(res.status).toBe(409);
	});

	it("POST /api/wiki rejects the reserved slug 'view' (PROJ-487, 400)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "View", content: "v1" }),
		});
		expect(res.status).toBe(400);
	});

	it("PUT /api/wiki/:slug rejects renaming to the reserved slug 'view' (PROJ-487, 400)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Gamma", content: "g" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/gamma", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "view" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/wiki rejects the reserved slug 'index' (PROJ-487, 400)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Index", content: "v1" }),
		});
		expect(res.status).toBe(400);
	});

	it("PUT /api/wiki/:slug rejects renaming to the reserved slug 'index' (PROJ-487, 400)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Delta", content: "d" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/delta", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "index" }),
		});
		expect(res.status).toBe(400);
	});

	it("PUT /api/wiki/:slug renaming the slug creates a redirect; the old slug still resolves", async () => {
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Roadmap", content: "v1" }),
		});
		const created = (await createRes.json()) as { slug: string };
		expect(created.slug).toBe("roadmap");

		const updateRes = await SELF.fetch("http://localhost/api/wiki/roadmap", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "product-roadmap" }),
		});
		expect(updateRes.status).toBe(200);
		const updated = (await updateRes.json()) as { url: string };
		expect(updated.url).toBe("/wiki/product-roadmap");

		const newRes = await SELF.fetch("http://localhost/api/wiki/product-roadmap", {
			headers: authHeaders(token, slug),
		});
		expect(newRes.status).toBe(200);

		const oldRes = await SELF.fetch("http://localhost/api/wiki/roadmap", {
			headers: authHeaders(token, slug),
		});
		expect(oldRes.status).toBe(200);
		const oldPage = (await oldRes.json()) as { slug: string; title: string };
		expect(oldPage.slug).toBe("product-roadmap");
		expect(oldPage.title).toBe("Roadmap");
	});

	it("PUT /api/wiki/:slug rejects renaming to a slug already used by another page (409)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Alpha", content: "a" }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Beta", content: "b" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/beta", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "alpha" }),
		});
		expect(res.status).toBe(409);
	});

	it("redirect chains collapse: renaming a page twice still resolves the original slug in one hop", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Docs", content: "v1" }),
		});

		await SELF.fetch("http://localhost/api/wiki/docs", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "docs-v2" }),
		});
		await SELF.fetch("http://localhost/api/wiki/docs-v2", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "docs-v3" }),
		});

		const originalRes = await SELF.fetch("http://localhost/api/wiki/docs", {
			headers: authHeaders(token, slug),
		});
		expect(originalRes.status).toBe(200);
		expect(((await originalRes.json()) as { slug: string }).slug).toBe("docs-v3");

		const intermediateRes = await SELF.fetch("http://localhost/api/wiki/docs-v2", {
			headers: authHeaders(token, slug),
		});
		expect(intermediateRes.status).toBe(200);
		expect(((await intermediateRes.json()) as { slug: string }).slug).toBe("docs-v3");
	});

	it("getWikiPage prefers a live page over a stale redirect for a reused slug (never ambiguous)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Old Name", content: "original" }),
		});
		await SELF.fetch("http://localhost/api/wiki/old-name", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "new-name" }),
		});

		// "old-name" is now only a redirect. A new page can legitimately claim it.
		const reclaimRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Reclaimed", slug: "old-name", content: "reclaimed" }),
		});
		expect(reclaimRes.status).toBe(201);

		const res = await SELF.fetch("http://localhost/api/wiki/old-name", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const page = (await res.json()) as { title: string };
		expect(page.title).toBe("Reclaimed");
	});

	it("the same slug in two different workspaces does not conflict", async () => {
		const other = await seedFixture();

		const first = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Shared Name", content: "workspace one" }),
		});
		expect(first.status).toBe(201);

		const second = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ title: "Shared Name", content: "workspace two" }),
		});
		expect(second.status).toBe(201);
		const secondPage = (await second.json()) as { slug: string };
		expect(secondPage.slug).toBe("shared-name");
	});

	it("a redirect created in one workspace does not resolve in another workspace", async () => {
		const other = await seedFixture();

		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Isolated", content: "v1" }),
		});
		await SELF.fetch("http://localhost/api/wiki/isolated", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "isolated-renamed" }),
		});

		// "isolated" is now a redirect in the first workspace only.
		const crossWorkspaceRes = await SELF.fetch("http://localhost/api/wiki/isolated", {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(crossWorkspaceRes.status).toBe(404);

		// A page in the other workspace is free to use "isolated" as its own live slug.
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ title: "Isolated", slug: "isolated", content: "other workspace" }),
		});
		expect(createRes.status).toBe(201);
	});

	it("MCP update_wiki_page newSlug renames the slug and old slug resolves via redirect (parity with REST)", async () => {
		const created = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Handbook", content: "v1" },
				authHeaders(token, slug)
			)
		);
		expect(created.slug).toBe("handbook");

		const updatedResult = mcpData<{ url: string }>(
			await mcpCall(
				workspaceId,
				"update_wiki_page",
				{ slug: "handbook", newSlug: "team-handbook" },
				authHeaders(token, slug)
			)
		);
		expect(updatedResult.url).toBe("/wiki/team-handbook");

		const oldPage = mcpData<{ slug: string }>(
			await mcpCall(workspaceId, "get_wiki_page", { slug: "handbook" }, authHeaders(token, slug))
		);
		expect(oldPage.slug).toBe("team-handbook");
	});

	it("MCP create_wiki_page rejects a colliding slug with a ConflictError (-32000)", async () => {
		await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "Conflict Page" },
			authHeaders(token, slug)
		);
		const res = await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "Conflict Page" },
			authHeaders(token, slug)
		);
		expect(isMcpError(res)).toBe(true);
		if (isMcpError(res)) expect(res.error.code).toBe(-32000);
	});
});

// PROJ-488 (R6): YAML frontmatter parsed and denormalized into wiki_pages columns on
// write, plus type/tags/status filtering on listWikiPages/searchWiki. REST/MCP parity
// throughout — each behavior is exercised via both surfaces.
describe("Wiki frontmatter metadata (PROJ-488)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	const RUNBOOK_CONTENT = [
		"---",
		"type: runbook",
		"tags: [ops, oncall]",
		"status: current",
		"verified_at: 2026-01-01",
		"verified_by: alice@example.com",
		"owners: [alice, bob]",
		"verify_interval: 90",
		"---",
		"# Runbook body",
	].join("\n");

	it("REST POST /api/wiki parses valid frontmatter into denormalized fields", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Incident Runbook", content: RUNBOOK_CONTENT }),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as {
			type: string;
			tags: string[];
			status: string;
			verifiedBy: string;
			owners: string[];
			verifyInterval: number;
		};
		expect(created.type).toBe("runbook");
		expect(created.tags).toEqual(["ops", "oncall"]);
		expect(created.status).toBe("current");
		expect(created.verifiedBy).toBe("alice@example.com");
		expect(created.owners).toEqual(["alice", "bob"]);
		expect(created.verifyInterval).toBe(90);

		const getRes = await SELF.fetch("http://localhost/api/wiki/incident-runbook", {
			headers: authHeaders(token, slug),
		});
		const page = (await getRes.json()) as {
			type: string;
			tags: string[] | string;
			status: string;
		};
		expect(page.type).toBe("runbook");
		expect(page.status).toBe("current");
		// tags column comes back through drizzle's JSON mode as a real array on GET.
		expect(page.tags).toEqual(["ops", "oncall"]);
	});

	it("MCP create_wiki_page parses valid frontmatter into denormalized fields (parity with REST)", async () => {
		const result = mcpData<{ type: string; tags: string[]; status: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Oncall Runbook", content: RUNBOOK_CONTENT },
				authHeaders(token, slug)
			)
		);
		expect(result.type).toBe("runbook");
		expect(result.tags).toEqual(["ops", "oncall"]);
		expect(result.status).toBe("current");
	});

	it("a page with no frontmatter gets empty/null metadata", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Plain Page", content: "just markdown, no frontmatter" }),
		});
		const created = (await res.json()) as {
			type: string | null;
			tags: string[];
			status: string | null;
		};
		expect(created.type).toBeNull();
		expect(created.tags).toEqual([]);
		expect(created.status).toBeNull();
	});

	// PROJ-513: `type` is freeform per the PRD — a value outside the well-known
	// runbook/adr/spec/note set is accepted and stored as-is, not rejected.
	it("REST POST /api/wiki accepts a `type` value outside the well-known set (PROJ-513)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Freeform Type",
				content: "---\ntype: whitepaper\n---\nbody",
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { type: string | null };
		expect(created.type).toBe("whitepaper");
	});

	it("MCP create_wiki_page accepts a `type` value outside the well-known set, parity with REST (PROJ-513)", async () => {
		const created = mcpData<{ type: string | null }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Freeform Type Mcp", content: "---\ntype: whitepaper\n---\nbody" },
				authHeaders(token, slug)
			)
		);
		expect(created.type).toBe("whitepaper");
	});

	// PROJ-513: the freeform value has to survive the whole round trip — stored on create,
	// then usable as a filter on both list and search, exactly like a well-known one.
	it("filters list/search by a `type` value outside the well-known set (PROJ-513)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Freeform Filter Whitepaper",
				content: "---\ntype: whitepaper\n---\nlatency budget",
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Freeform Filter Adr",
				content: "---\ntype: adr\n---\nlatency budget",
			}),
		});

		const listRes = await SELF.fetch("http://localhost/api/wiki?type=whitepaper", {
			headers: authHeaders(token, slug),
		});
		const listed = (await listRes.json()) as Array<{ title: string }>;
		expect(listed.map((r) => r.title)).toEqual(["Freeform Filter Whitepaper"]);

		const searchRes = await SELF.fetch(
			"http://localhost/api/wiki/search?q=latency&type=whitepaper",
			{ headers: authHeaders(token, slug) }
		);
		const found = (await searchRes.json()) as Array<{ title: string }>;
		expect(found.map((r) => r.title)).toEqual(["Freeform Filter Whitepaper"]);

		const mcpListed = mcpData<Array<{ title: string }>>(
			await mcpCall(
				workspaceId,
				"list_wiki_pages",
				{ type: "whitepaper" },
				authHeaders(token, slug)
			)
		);
		expect(mcpListed.map((r) => r.title)).toEqual(["Freeform Filter Whitepaper"]);
	});

	it("rejects an invalid `status` enum value with a structured error", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Bad Status",
				content: "---\nstatus: archived\n---\nbody",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects malformed YAML in the frontmatter block with a structured error, not a silent drop", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Bad Yaml",
				content: "---\ntags: [unterminated\n---\nbody",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects an unrecognized frontmatter key rather than silently ignoring it", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Typo Key",
				content: "---\nstauts: current\n---\nbody",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects tags with the wrong type (a string instead of an array)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Bad Tags",
				content: "---\ntags: ops\n---\nbody",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a frontmatter block that isn't a YAML mapping", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "List Frontmatter",
				content: "---\n- one\n- two\n---\nbody",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a verified_at that isn't a parseable date", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Bad Verified At",
				content: "---\nverified_at: last tuesday\n---\nbody",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a verified_at that is neither a date nor a number", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Boolean Verified At",
				content: "---\nverified_at: true\n---\nbody",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("accepts a verified_at given as unix seconds", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Unix Verified At",
				content: "---\nverified_at: 1700000000\n---\nbody",
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { verifiedAt: number };
		expect(created.verifiedAt).toBe(1_700_000_000);
	});

	it("update_wiki_page reparses frontmatter when content changes", async () => {
		const created = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Evolving Doc", content: RUNBOOK_CONTENT },
				authHeaders(token, slug)
			)
		);

		await mcpCall(
			workspaceId,
			"update_wiki_page",
			{ slug: created.slug, content: "---\ntype: adr\nstatus: deprecated\n---\nnew body" },
			authHeaders(token, slug)
		);

		const page = mcpData<{ type: string; status: string; tags: string[] }>(
			await mcpCall(workspaceId, "get_wiki_page", { slug: created.slug }, authHeaders(token, slug))
		);
		expect(page.type).toBe("adr");
		expect(page.status).toBe("deprecated");
		expect(page.tags).toEqual([]);
	});

	it("update_wiki_page leaves existing frontmatter metadata unchanged when content is omitted", async () => {
		const created = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Stable Doc", content: RUNBOOK_CONTENT },
				authHeaders(token, slug)
			)
		);

		await mcpCall(
			workspaceId,
			"update_wiki_page",
			{ slug: created.slug, title: "Stable Doc (renamed title)" },
			authHeaders(token, slug)
		);

		const page = mcpData<{ type: string; status: string; tags: string[] }>(
			await mcpCall(workspaceId, "get_wiki_page", { slug: created.slug }, authHeaders(token, slug))
		);
		expect(page.type).toBe("runbook");
		expect(page.status).toBe("current");
		expect(page.tags).toEqual(["ops", "oncall"]);
	});

	it("update_wiki_page rejects invalid frontmatter on a content edit", async () => {
		const created = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Will Fail Update", content: RUNBOOK_CONTENT },
				authHeaders(token, slug)
			)
		);
		const res = await mcpCall(
			workspaceId,
			"update_wiki_page",
			// PROJ-513: `type` is freeform now, so use an invalid `status` (still a closed
			// enum) to exercise the same "invalid frontmatter on update" path.
			{ slug: created.slug, content: "---\nstatus: not-a-real-status\n---\nbody" },
			authHeaders(token, slug)
		);
		expect(isMcpError(res)).toBe(true);
		if (isMcpError(res)) expect(res.error.code).toBe(-32602);
	});

	it("REST GET /api/wiki filters by type and status", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Filter Runbook", content: RUNBOOK_CONTENT }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Filter Adr",
				content: "---\ntype: adr\nstatus: draft\n---\nbody",
			}),
		});

		const byType = await SELF.fetch("http://localhost/api/wiki?type=adr", {
			headers: authHeaders(token, slug),
		});
		const byTypeResults = (await byType.json()) as Array<{ title: string }>;
		expect(byTypeResults.map((r) => r.title)).toEqual(["Filter Adr"]);

		const byStatus = await SELF.fetch("http://localhost/api/wiki?status=current", {
			headers: authHeaders(token, slug),
		});
		const byStatusResults = (await byStatus.json()) as Array<{ title: string }>;
		expect(byStatusResults.map((r) => r.title)).toEqual(["Filter Runbook"]);
	});

	it("REST GET /api/wiki?tags= filters by any-of tag match", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Tagged Ops", content: "---\ntags: [ops]\n---\nbody" }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Tagged Frontend",
				content: "---\ntags: [frontend]\n---\nbody",
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Untagged", content: "no frontmatter here" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki?tags=ops,frontend", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title).sort()).toEqual(["Tagged Frontend", "Tagged Ops"]);
	});

	it("MCP list_wiki_pages filters by tags (any-of), parity with REST", async () => {
		await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "Mcp Tagged Ops", content: "---\ntags: [ops]\n---\nbody" },
			authHeaders(token, slug)
		);
		await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "Mcp Untagged", content: "no frontmatter" },
			authHeaders(token, slug)
		);

		const result = mcpData<Array<{ title: string }>>(
			await mcpCall(workspaceId, "list_wiki_pages", { tags: ["ops"] }, authHeaders(token, slug))
		);
		expect(result.map((r) => r.title)).toEqual(["Mcp Tagged Ops"]);
	});

	it("REST GET /api/wiki/search filters by type/status/tags on top of the FTS match", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Deploy Runbook",
				content: "---\ntype: runbook\nstatus: current\ntags: [deploy]\n---\ndeploy steps",
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Deploy Adr",
				content: "---\ntype: adr\nstatus: draft\ntags: [deploy]\n---\ndeploy decision",
			}),
		});

		const res = await SELF.fetch(
			"http://localhost/api/wiki/search?q=deploy&type=runbook&status=current&tags=deploy",
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title)).toEqual(["Deploy Runbook"]);
	});

	it("search results return tags/owners as arrays, same shape as list and get", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Shape Runbook", content: RUNBOOK_CONTENT }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=Runbook", {
			headers: authHeaders(token, slug),
		});
		const [hit] = (await res.json()) as Array<{ tags: string[]; owners: string[] }>;
		expect(hit.tags).toEqual(["ops", "oncall"]);
		expect(hit.owners).toEqual(["alice", "bob"]);

		const listRes = await SELF.fetch("http://localhost/api/wiki?type=runbook", {
			headers: authHeaders(token, slug),
		});
		const [listed] = (await listRes.json()) as Array<{ tags: string[]; owners: string[] }>;
		expect(hit.tags).toEqual(listed.tags);
		expect(hit.owners).toEqual(listed.owners);
	});

	it("MCP search_wiki filters by type, parity with REST", async () => {
		await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "Widget Runbook", content: "---\ntype: runbook\n---\nwidget steps" },
			authHeaders(token, slug)
		);
		await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "Widget Spec", content: "---\ntype: spec\n---\nwidget spec" },
			authHeaders(token, slug)
		);

		const result = mcpData<Array<{ title: string }>>(
			await mcpCall(
				workspaceId,
				"search_wiki",
				{ query: "widget", type: "spec" },
				authHeaders(token, slug)
			)
		);
		expect(result.map((r) => r.title)).toEqual(["Widget Spec"]);
	});
});

// PROJ-509: list_wiki_revisions/get_wiki_revision/delete_wiki_page resolve via
// id-or-slug + redirect fallback, matching get_wiki_page/update_wiki_page/
// get_wiki_backlinks — a renamed page's old slug must keep working for every entry
// point, not just get_wiki_page (PROJ-484's optimistic-locking workflow fetches
// baseRevisionId via list_wiki_revisions using whatever reference the caller holds).
describe("Wiki revisions/delete resolve by old slug after rename (PROJ-509)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	it("REST: GET /:slug/revisions resolves via an old (pre-rename) slug", async () => {
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Runbook", content: "v1" }),
		});
		expect(createRes.status).toBe(201);

		const editRes = await SELF.fetch("http://localhost/api/wiki/runbook", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		expect(editRes.status).toBe(200);

		const renameRes = await SELF.fetch("http://localhost/api/wiki/runbook", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "operations-runbook" }),
		});
		expect(renameRes.status).toBe(200);
		await env.DB.prepare("DELETE FROM rate_limit").run();

		// "runbook" is now only a redirect — the old slug must still resolve here, same
		// as GET /:slug (getWikiPage).
		const revRes = await SELF.fetch("http://localhost/api/wiki/runbook/revisions", {
			headers: authHeaders(token, slug),
		});
		expect(revRes.status).toBe(200);
		const revisions = (await revRes.json()) as Array<{ id: string; title: string }>;
		expect(revisions).toHaveLength(1);
		expect(revisions[0].title).toBe("Runbook");
	});

	it("REST: GET /:slug/revisions/:revisionId resolves via an old (pre-rename) slug", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Playbook", content: "v1" }),
		});
		await SELF.fetch("http://localhost/api/wiki/playbook", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		const revRes = await SELF.fetch("http://localhost/api/wiki/playbook/revisions", {
			headers: authHeaders(token, slug),
		});
		const [revision] = (await revRes.json()) as Array<{ id: string }>;

		await SELF.fetch("http://localhost/api/wiki/playbook", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "team-playbook" }),
		});
		await env.DB.prepare("DELETE FROM rate_limit").run();

		const detailRes = await SELF.fetch(
			`http://localhost/api/wiki/playbook/revisions/${revision.id}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()) as { id: string; content: string };
		expect(detail.id).toBe(revision.id);
		expect(detail.content).toBe("v1");
	});

	it("MCP: list_wiki_revisions and get_wiki_revision resolve via an old (pre-rename) slug", async () => {
		const created = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Charter", content: "v1" },
				authHeaders(token, slug)
			)
		);
		await mcpCall(
			workspaceId,
			"update_wiki_page",
			{ slug: created.slug, content: "v2" },
			authHeaders(token, slug)
		);
		await env.DB.prepare("DELETE FROM rate_limit").run();
		await mcpCall(
			workspaceId,
			"update_wiki_page",
			{ slug: created.slug, newSlug: "team-charter" },
			authHeaders(token, slug)
		);
		await env.DB.prepare("DELETE FROM rate_limit").run();

		const revisions = mcpData<Array<{ id: string; title: string }>>(
			await mcpCall(
				workspaceId,
				"list_wiki_revisions",
				{ slug: created.slug },
				authHeaders(token, slug)
			)
		);
		expect(revisions).toHaveLength(1);
		expect(revisions[0].title).toBe("Charter");

		const revision = mcpData<{ id: string; content: string }>(
			await mcpCall(
				workspaceId,
				"get_wiki_revision",
				{ slug: created.slug, revisionId: revisions[0].id },
				authHeaders(token, slug)
			)
		);
		expect(revision.content).toBe("v1");
	});

	it("REST: DELETE /:slug resolves via an old (pre-rename) slug", async () => {
		// Deleting a workspace-level page requires admin/owner (services/wiki.ts).
		const owner = await seedFixture({ role: "owner" });
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(owner.token, owner.workspace.slug),
			body: JSON.stringify({ title: "Draft Notes", content: "v1" }),
		});
		await SELF.fetch("http://localhost/api/wiki/draft-notes", {
			method: "PUT",
			headers: authHeaders(owner.token, owner.workspace.slug),
			body: JSON.stringify({ slug: "archived-notes" }),
		});
		await env.DB.prepare("DELETE FROM rate_limit").run();

		// "draft-notes" is now only a redirect — deleting by the old slug should resolve
		// to the same (renamed) page rather than 404ing.
		const deleteRes = await SELF.fetch("http://localhost/api/wiki/draft-notes", {
			method: "DELETE",
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		expect(deleteRes.status).toBe(200);
		const body = (await deleteRes.json()) as { ok: boolean; deletedCount: number };
		expect(body.ok).toBe(true);
		expect(body.deletedCount).toBe(1);

		const getRes = await SELF.fetch("http://localhost/api/wiki/archived-notes", {
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		expect(getRes.status).toBe(404);
	});
});

// PROJ-484: optimistic locking (baseRevisionId + conflict diff) on wiki writes
describe("Wiki optimistic locking (PROJ-484)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	// The test env's RATE_LIMIT_API_MAX is 5 req/window (wrangler.test.toml), and these
	// tests each fire more than that against one token — reset the counter before every
	// request (same escape hatch as PROJ-238's nesting-depth test above).
	async function req(url: string, opts?: RequestInit) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return SELF.fetch(url, opts);
	}

	async function mcp<T>(name: string, args: unknown) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return mcpCall<T>(workspaceId, name, args, authHeaders(token, slug));
	}

	async function getRevisions(pageSlug: string) {
		const res = await req(`http://localhost/api/wiki/${pageSlug}/revisions`, {
			headers: authHeaders(token, slug),
		});
		return (await res.json()) as Array<{
			id: string;
			title: string;
			summary: string | null;
			created_at: number;
		}>;
	}

	it("REST: update with no baseRevisionId still succeeds (transitional last-write-wins)", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Transitional", content: "v1" }),
		});

		const res = await req("http://localhost/api/wiki/transitional", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		expect(res.status).toBe(200);

		const pageRes = await req("http://localhost/api/wiki/transitional", {
			headers: authHeaders(token, slug),
		});
		expect(((await pageRes.json()) as { content: string }).content).toBe("v2");
	});

	it("REST: update succeeds when baseRevisionId matches the current latest revision", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Locked Doc", content: "v1" }),
		});
		// First edit (no base yet) creates the first revision, capturing "v1".
		await req("http://localhost/api/wiki/locked-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		const [latest] = await getRevisions("locked-doc");

		const res = await req("http://localhost/api/wiki/locked-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v3", baseRevisionId: latest.id }),
		});
		expect(res.status).toBe(200);

		const pageRes = await req("http://localhost/api/wiki/locked-doc", {
			headers: authHeaders(token, slug),
		});
		expect(((await pageRes.json()) as { content: string }).content).toBe("v3");
	});

	it("REST: update is rejected with a structured conflict when baseRevisionId is stale", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Contested Doc", content: "v1" }),
		});
		await req("http://localhost/api/wiki/contested-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		const [staleRevision] = await getRevisions("contested-doc");

		// Someone else edits again, advancing the latest revision past staleRevision.
		await req("http://localhost/api/wiki/contested-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v3" }),
		});
		const [currentLatest] = await getRevisions("contested-doc");
		expect(currentLatest.id).not.toBe(staleRevision.id);

		const res = await req("http://localhost/api/wiki/contested-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v4 (stale attempt)", baseRevisionId: staleRevision.id }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; currentRevisionId: string; diff: string };
		expect(body.currentRevisionId).toBe(currentLatest.id);
		expect(typeof body.diff).toBe("string");
		// staleRevision snapshots the pre-edit content of the FIRST edit ("v1"), i.e. the
		// content the caller actually had once that edit landed is the NEXT revision's
		// snapshot ("v2"). The diff base is therefore "v2", not staleRevision's own "v1".
		expect(body.diff).toContain("v2");
		expect(body.diff).toContain("v3");

		// The stale write never applied.
		const pageRes = await req("http://localhost/api/wiki/contested-doc", {
			headers: authHeaders(token, slug),
		});
		expect(((await pageRes.json()) as { content: string }).content).toBe("v3");
	});

	it("REST: revision rows get a title snapshot", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Snapshot Title", content: "v1" }),
		});
		await req("http://localhost/api/wiki/snapshot-title", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});

		const [revision] = await getRevisions("snapshot-title");
		expect(revision.title).toBe("Snapshot Title");
	});

	it("REST: summary is stored and returned when provided", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Summarized Doc", content: "v1" }),
		});
		await req("http://localhost/api/wiki/summarized-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2", summary: "Fixed a typo" }),
		});

		const [revision] = await getRevisions("summarized-doc");
		expect(revision.summary).toBe("Fixed a typo");
	});

	it("REST: update is rejected with a validation error when baseRevisionId doesn't belong to the page", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Garbage Base Doc", content: "v1" }),
		});
		const res = await req("http://localhost/api/wiki/garbage-base-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2", baseRevisionId: crypto.randomUUID() }),
		});
		expect(res.status).toBe(400);
	});

	it("MCP: update_wiki_page parity — matching baseRevisionId succeeds, stale is rejected with a structured conflict", async () => {
		const created = mcpData<{ slug: string }>(
			await mcp("create_wiki_page", { title: "MCP Locked Doc", content: "v1" })
		);

		await mcp("update_wiki_page", { slug: created.slug, content: "v2" });
		const revisionsAfterFirstEdit = mcpData<Array<{ id: string }>>(
			await mcp("list_wiki_revisions", { slug: created.slug })
		);
		const [staleRevision] = revisionsAfterFirstEdit;

		// Matching baseRevisionId succeeds.
		const okResult = await mcp("update_wiki_page", {
			slug: created.slug,
			content: "v3",
			baseRevisionId: staleRevision.id,
			summary: "v3 edit",
		});
		expect(isMcpError(okResult)).toBe(false);

		const revisionsAfterSecondEdit = mcpData<Array<{ id: string; summary: string | null }>>(
			await mcp("list_wiki_revisions", { slug: created.slug })
		);
		const [currentLatest] = revisionsAfterSecondEdit;
		expect(currentLatest.id).not.toBe(staleRevision.id);
		expect(currentLatest.summary).toBe("v3 edit");

		// Stale baseRevisionId is rejected with a structured conflict.
		const conflictResult = await mcp("update_wiki_page", {
			slug: created.slug,
			content: "v4 (stale attempt)",
			baseRevisionId: staleRevision.id,
		});
		expect(isMcpError(conflictResult)).toBe(true);
		if (isMcpError(conflictResult)) {
			expect(conflictResult.error.code).toBe(-32000);
			const parsed = JSON.parse(conflictResult.error.message) as {
				currentRevisionId: string;
				diff: string;
			};
			expect(parsed.currentRevisionId).toBe(currentLatest.id);
			// staleRevision snapshots the pre-edit content of the FIRST edit ("v1"); the
			// content the caller actually had is the NEXT revision's snapshot ("v2"), which
			// is the correct diff base — not staleRevision's own "v1".
			expect(parsed.diff).toContain("v2");
			expect(parsed.diff).toContain("v3");
		}
	});
});

// PROJ-483: exercises the dedup UPDATE statement from 0041_wiki_slug_unique.sql in
// isolation. The migration itself runs before any tests seed data (test/setup.ts's
// beforeAll), so by the time tests execute the unique index is already enforcing —
// there is no way to get duplicate wiki_pages rows through the running app to
// re-verify the migration end-to-end. Running the identical dedup SQL against a
// scratch table shaped like the pre-migration wiki_pages table verifies the
// algorithm's correctness directly instead.
describe("wiki slug dedup algorithm (0041_wiki_slug_unique.sql)", () => {
	const DEDUP_SQL = `WITH ranked AS (
		SELECT id, ROW_NUMBER() OVER (
			PARTITION BY workspace_id, slug ORDER BY created_at, id
		) AS rn
		FROM dedup_scratch
	)
	UPDATE dedup_scratch
	SET slug = dedup_scratch.slug || '-' || substr(dedup_scratch.id, 1, 8)
	WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`;

	async function withScratchTable(fn: () => Promise<void>) {
		await env.DB.prepare(
			`CREATE TABLE dedup_scratch (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				slug TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)`
		).run();
		try {
			await fn();
		} finally {
			await env.DB.prepare("DROP TABLE dedup_scratch").run();
		}
	}

	it("keeps the oldest page's slug and appends an id-derived suffix to newer duplicates", async () => {
		await withScratchTable(async () => {
			await env.DB.prepare(
				"INSERT INTO dedup_scratch (id, workspace_id, slug, created_at) VALUES " +
					"('p1', 'ws1', 'operations', 100), ('p2', 'ws1', 'operations', 200), " +
					"('p3', 'ws1', 'operations', 300), ('p4', 'ws1', 'other', 100)"
			).run();

			await env.DB.prepare(DEDUP_SQL).run();

			const { results } = await env.DB.prepare(
				"SELECT id, slug FROM dedup_scratch ORDER BY id"
			).all<{ id: string; slug: string }>();
			expect(results).toEqual([
				{ id: "p1", slug: "operations" },
				{ id: "p2", slug: "operations-p2" },
				{ id: "p3", slug: "operations-p3" },
				{ id: "p4", slug: "other" },
			]);
		});
	});

	it("doesn't collide with a pre-existing slug that looks like a row-number suffix", async () => {
		// Regression case: a plain `-2` / `-3` row-number suffix would collide with an
		// unrelated page that already happens to be named e.g. "operations-2", aborting
		// the UNIQUE INDEX creation that follows this UPDATE. An id-derived suffix can't
		// collide with a pre-existing slug this way.
		await withScratchTable(async () => {
			await env.DB.prepare(
				"INSERT INTO dedup_scratch (id, workspace_id, slug, created_at) VALUES " +
					"('p1', 'ws1', 'operations', 100), ('p2', 'ws1', 'operations', 200), " +
					"('p3', 'ws1', 'operations-2', 50)"
			).run();

			await env.DB.prepare(DEDUP_SQL).run();

			const { results } = await env.DB.prepare(
				"SELECT id, slug FROM dedup_scratch ORDER BY id"
			).all<{ id: string; slug: string }>();
			const slugs = results.map((r) => r.slug);
			expect(new Set(slugs).size).toBe(slugs.length);
			expect(results.find((r) => r.id === "p1")?.slug).toBe("operations");
			expect(results.find((r) => r.id === "p3")?.slug).toBe("operations-2");
		});
	});
});

describe("Wiki link graph and backlinks (PROJ-485)", () => {
	let token: string;
	let slug: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
	});

	async function createPage(title: string, content: string) {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title, content }),
		});
		return (await res.json()) as { id: string; slug: string };
	}

	it("[[Target]] and [[Target|label]] both resolve a backlink to the target page", async () => {
		const target = await createPage("Runbook", "how to page");
		await createPage("Alpha", "see [[Runbook]] for details");
		await createPage("Beta", "see [[Runbook|the runbook]] for details");

		const res = await SELF.fetch(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const backlinks = (await res.json()) as Array<{ slug: string; title: string }>;
		expect(backlinks.map((b) => b.slug).sort()).toEqual(["alpha", "beta"]);
	});

	it("a same-workspace wiki URL link resolves a backlink", async () => {
		const target = await createPage("Handbook", "contents");
		await createPage("Gamma", `[link](/wiki/${target.slug})`);

		const res = await SELF.fetch(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		const backlinks = (await res.json()) as Array<{ slug: string }>;
		expect(backlinks.map((b) => b.slug)).toEqual(["gamma"]);
	});

	it("an absolute cross-host URL is never indexed as a same-workspace link", async () => {
		const target = await createPage("Epsilon", "contents");
		await createPage(
			"Zeta",
			`[external](https://example.com/wiki/${target.slug}) and [also](//other-host/wiki/${target.slug})`
		);

		const res = await SELF.fetch(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		const backlinks = (await res.json()) as Array<{ slug: string }>;
		expect(backlinks).toEqual([]);
	});

	it("PROJ-510: a malformed %-escape in a markdown link URL doesn't crash the write, and other links on the page still index", async () => {
		const runbook = await createPage("Runbook Eta", "how to page");
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Theta",
				content: "see [[Runbook Eta]] and [bad](/wiki?slug=100%) for details",
			}),
		});
		expect(res.status).toBe(201);

		const backlinksRes = await SELF.fetch(`http://localhost/api/wiki/${runbook.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		const backlinks = (await backlinksRes.json()) as Array<{ slug: string }>;
		expect(backlinks.map((b) => b.slug)).toEqual(["theta"]);
	});

	it("an unresolved [[Target]] is stored as a broken link, not a backlink", async () => {
		await createPage("Delta", "see [[Nonexistent Page]] for details");

		const brokenRes = await SELF.fetch("http://localhost/api/wiki/broken-links", {
			headers: authHeaders(token, slug),
		});
		const broken = (await brokenRes.json()) as Array<{ sourceSlug: string; targetTitle: string }>;
		expect(broken).toContainEqual(
			expect.objectContaining({ sourceSlug: "delta", targetTitle: "Nonexistent Page" })
		);
	});

	it("get_backlinks (MCP) returns the same result as REST", async () => {
		const fixture = await seedFixture();
		const target = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(fixture.token, fixture.workspace.slug),
			body: JSON.stringify({ title: "MCP Target", content: "x" }),
		}).then((r) => r.json() as Promise<{ slug: string }>);
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(fixture.token, fixture.workspace.slug),
			body: JSON.stringify({ title: "MCP Source", content: "[[MCP Target]]" }),
		});

		const result = await mcpCall<{ content: Array<{ text: string }> }>(
			fixture.workspace.id,
			"get_backlinks",
			{ slug: target.slug },
			authHeaders(fixture.token, fixture.workspace.slug)
		);
		const backlinks = mcpData<Array<{ slug: string }>>(result);
		expect(backlinks).toEqual([expect.objectContaining({ slug: "mcp-source" })]);
	});

	it("list_broken_wiki_links (MCP) matches REST", async () => {
		const fixture = await seedFixture();
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(fixture.token, fixture.workspace.slug),
			body: JSON.stringify({ title: "Epsilon", content: "[[Missing Target]]" }),
		});

		const result = await mcpCall<{ content: Array<{ text: string }> }>(
			fixture.workspace.id,
			"list_broken_wiki_links",
			{},
			authHeaders(fixture.token, fixture.workspace.slug)
		);
		const broken = mcpData<Array<{ targetTitle: string }>>(result);
		expect(broken).toContainEqual(expect.objectContaining({ targetTitle: "Missing Target" }));
	});

	it("renaming the target page's slug doesn't break an existing backlink (id-backed)", async () => {
		const target = await createPage("Original Name", "content");
		await createPage("Linker", "see [[Original Name]]");

		await SELF.fetch(`http://localhost/api/wiki/${target.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "renamed-slug" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/renamed-slug/backlinks", {
			headers: authHeaders(token, slug),
		});
		const backlinks = (await res.json()) as Array<{ slug: string }>;
		expect(backlinks.map((b) => b.slug)).toEqual(["linker"]);
	});

	it("editing content to remove a link removes the backlink; a new link adds one", async () => {
		const target = await createPage("Stable Target", "x");
		const linker = await createPage("Changing Source", "see [[Stable Target]]");

		let res = await SELF.fetch(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		expect(((await res.json()) as unknown[]).length).toBe(1);

		await SELF.fetch(`http://localhost/api/wiki/${linker.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "no more links here" }),
		});

		res = await SELF.fetch(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		expect(await res.json()).toEqual([]);
	});

	it("a title-only update (no content change) leaves the link graph untouched", async () => {
		const target = await createPage("Untouched Target", "x");
		const linker = await createPage("Title Change Source", "see [[Untouched Target]]");

		await SELF.fetch(`http://localhost/api/wiki/${linker.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Renamed Title Only" }),
		});

		const res = await SELF.fetch(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		const backlinks = (await res.json()) as Array<{ slug: string }>;
		expect(backlinks.map((b) => b.slug)).toEqual(["title-change-source"]);
	});

	it("DELETE surfaces linkedByCount as a non-blocking warning and still deletes the page", async () => {
		const owner = await seedFixture({ role: "owner" });
		const target = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(owner.token, owner.workspace.slug),
			body: JSON.stringify({ title: "Linked Target", content: "x" }),
		}).then((r) => r.json() as Promise<{ slug: string }>);
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(owner.token, owner.workspace.slug),
			body: JSON.stringify({ title: "Linker One", content: "[[Linked Target]]" }),
		});

		const res = await SELF.fetch(`http://localhost/api/wiki/${target.slug}`, {
			method: "DELETE",
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; linkedByCount: number };
		expect(body.linkedByCount).toBe(1);

		const getRes = await SELF.fetch(`http://localhost/api/wiki/${target.slug}`, {
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		expect(getRes.status).toBe(404);

		// The now-deleted target turns the surviving linker's outgoing link into a broken
		// link (target_page_id set null) rather than silently vanishing.
		const brokenRes = await SELF.fetch("http://localhost/api/wiki/broken-links", {
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		const broken = (await brokenRes.json()) as Array<{ targetTitle: string }>;
		expect(broken).toContainEqual(expect.objectContaining({ targetTitle: "Linked Target" }));
	});

	it("cascade-deleting a subtree cleans up outgoing links for every deleted page", async () => {
		const owner = await seedFixture({ role: "owner" });
		const parentRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(owner.token, owner.workspace.slug),
			body: JSON.stringify({ title: "Cascade Parent", content: "[[Nonexistent A]]" }),
		});
		const parent = (await parentRes.json()) as { id: string; slug: string };
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(owner.token, owner.workspace.slug),
			body: JSON.stringify({
				title: "Cascade Child",
				content: "[[Nonexistent B]]",
				parentId: parent.id,
			}),
		});

		await SELF.fetch(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: authHeaders(owner.token, owner.workspace.slug),
		});

		const brokenRes = await SELF.fetch("http://localhost/api/wiki/broken-links", {
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		const broken = (await brokenRes.json()) as Array<{ targetTitle: string }>;
		expect(broken.some((b) => b.targetTitle === "Nonexistent A")).toBe(false);
		expect(broken.some((b) => b.targetTitle === "Nonexistent B")).toBe(false);
	});

	it("backlinks and broken links never cross workspace boundaries", async () => {
		const workspaceA = await seedFixture();
		const workspaceB = await seedFixture();

		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(workspaceA.token, workspaceA.workspace.slug),
			body: JSON.stringify({ title: "Shared Title", content: "x" }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(workspaceB.token, workspaceB.workspace.slug),
			body: JSON.stringify({ title: "B Source", content: "see [[Shared Title]]" }),
		});

		// workspace B's link can only resolve against workspace B's own pages, so it's
		// unresolved there (no "Shared Title" page exists in B) — never leaking a match
		// against workspace A's page of the same title.
		const brokenB = await SELF.fetch("http://localhost/api/wiki/broken-links", {
			headers: authHeaders(workspaceB.token, workspaceB.workspace.slug),
		});
		expect(
			((await brokenB.json()) as Array<{ targetTitle: string }>).some(
				(b) => b.targetTitle === "Shared Title"
			)
		).toBe(true);

		const sharedA = await SELF.fetch("http://localhost/api/wiki/shared-title", {
			headers: authHeaders(workspaceA.token, workspaceA.workspace.slug),
		});
		const target = (await sharedA.json()) as { id: string };
		const backlinksA = await SELF.fetch(`http://localhost/api/wiki/${target.id}/backlinks`, {
			headers: authHeaders(workspaceA.token, workspaceA.workspace.slug),
		});
		expect(await backlinksA.json()).toEqual([]);
	});

	it("backfill_wiki_links (MCP, owner-only) recomputes links for pre-existing content", async () => {
		const owner = await seedFixture({ role: "owner" });
		// Seed pages directly at the DB layer, bypassing reindexWikiLinks, to simulate
		// pre-PROJ-485 content that predates the link graph.
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			"INSERT INTO wiki_pages (id, workspace_id, slug, title, content, created_by_id, updated_by_id, created_at, updated_at) " +
				"VALUES ('legacy-target', ?, 'legacy-target', 'Legacy Target', 'x', ?, ?, ?, ?)"
		)
			.bind(owner.workspace.id, owner.user.id, owner.user.id, now, now)
			.run();
		await env.DB.prepare(
			"INSERT INTO wiki_pages (id, workspace_id, slug, title, content, created_by_id, updated_by_id, created_at, updated_at) " +
				"VALUES ('legacy-source', ?, 'legacy-source', 'Legacy Source', '[[Legacy Target]]', ?, ?, ?, ?)"
		)
			.bind(owner.workspace.id, owner.user.id, owner.user.id, now, now)
			.run();

		const preBacklinks = await SELF.fetch("http://localhost/api/wiki/legacy-target/backlinks", {
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		expect(await preBacklinks.json()).toEqual([]);

		const result = await mcpCall<{ content: Array<{ text: string }> }>(
			owner.workspace.id,
			"backfill_wiki_links",
			{},
			authHeaders(owner.token, owner.workspace.slug)
		);
		const backfillResult = mcpData<{ pagesProcessed: number }>(result);
		expect(backfillResult.pagesProcessed).toBeGreaterThanOrEqual(2);

		const postBacklinks = await SELF.fetch("http://localhost/api/wiki/legacy-target/backlinks", {
			headers: authHeaders(owner.token, owner.workspace.slug),
		});
		const backlinks = (await postBacklinks.json()) as Array<{ slug: string }>;
		expect(backlinks.map((b) => b.slug)).toEqual(["legacy-source"]);
	});

	it("backfill_wiki_links is rejected for a non-admin member", async () => {
		const member = await seedFixture({ role: "member" });
		const result = await mcpCall(
			member.workspace.id,
			"backfill_wiki_links",
			{},
			authHeaders(member.token, member.workspace.slug)
		);
		expect(isMcpError(result)).toBe(true);
	});
});

// PROJ-489 (R7): verification stamps + computed staleness surfacing.
describe("computeFreshness (PROJ-489)", () => {
	it("returns null when the page has neither verify_interval nor status", () => {
		expect(computeFreshness({ verifiedAt: null, verifyInterval: null, status: null })).toBeNull();
	});

	it("returns 'unverified' when verify_interval is set but verified_at is null", () => {
		expect(
			computeFreshness({ verifiedAt: null, verifyInterval: 30, status: null, now: 1_000_000 })
		).toEqual({ state: "unverified", staleSince: null });
	});

	it("returns 'fresh' when verify_interval hasn't elapsed since verified_at", () => {
		const now = 1_000_000;
		const verifiedAt = now - 10 * 86400; // 10 days ago
		expect(computeFreshness({ verifiedAt, verifyInterval: 30, status: null, now })).toEqual({
			state: "fresh",
			staleSince: null,
		});
	});

	it("returns 'stale' with staleSince once verify_interval has elapsed since verified_at", () => {
		const now = 1_000_000;
		const verifiedAt = now - 40 * 86400; // 40 days ago
		const dueAt = verifiedAt + 30 * 86400;
		expect(computeFreshness({ verifiedAt, verifyInterval: 30, status: null, now })).toEqual({
			state: "stale",
			staleSince: dueAt,
		});
	});

	it("treats an explicit status: stale as stale regardless of verify_interval", () => {
		expect(
			computeFreshness({ verifiedAt: null, verifyInterval: null, status: "stale", now: 1_000_000 })
		).toEqual({ state: "stale", staleSince: null });
	});

	it("treats an explicit status: deprecated as stale even when verify_interval hasn't elapsed yet", () => {
		const now = 1_000_000;
		const verifiedAt = now - 1 * 86400; // verified yesterday
		expect(
			computeFreshness({ verifiedAt, verifyInterval: 365, status: "deprecated", now })
		).toEqual({ state: "stale", staleSince: null });
	});

	it("treats status: current with no verify_interval as fresh", () => {
		expect(
			computeFreshness({
				verifiedAt: null,
				verifyInterval: null,
				status: "current",
				now: 1_000_000,
			})
		).toEqual({ state: "fresh", staleSince: null });
	});
});

describe("Wiki freshness model (PROJ-489)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userEmail: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userEmail = fixture.user.email;
	});

	const today = () => new Date().toISOString().slice(0, 10);

	function overdueContent(intervalDays = 30) {
		return [
			"---",
			`verify_interval: ${intervalDays}`,
			"verified_at: 2020-01-01",
			"---",
			"# Overdue page",
		].join("\n");
	}

	function freshContent(intervalDays = 365) {
		return [
			"---",
			`verify_interval: ${intervalDays}`,
			`verified_at: ${today()}`,
			"---",
			"# Fresh page",
		].join("\n");
	}

	function unverifiedContent(intervalDays = 30) {
		return ["---", `verify_interval: ${intervalDays}`, "---", "# Never verified page"].join("\n");
	}

	function explicitStatusContent(status: "stale" | "deprecated") {
		return ["---", `status: ${status}`, "---", "# Explicitly flagged page"].join("\n");
	}

	it("REST GET /api/wiki/:slug returns computed freshness in the page header", async () => {
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Overdue Runbook", content: overdueContent() }),
		});
		const created = (await createRes.json()) as { slug: string };

		const res = await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { freshness: { state: string; staleSince: number | null } };
		expect(page.freshness.state).toBe("stale");
		expect(page.freshness.staleSince).not.toBeNull();
	});

	it("REST POST /api/wiki/:slug/verify stamps verified_at/verified_by using the CALLING user's identity", async () => {
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Needs Verification", content: overdueContent() }),
		});
		const created = (await createRes.json()) as { slug: string };

		const verifyRes = await SELF.fetch(`http://localhost/api/wiki/${created.slug}/verify`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(verifyRes.status).toBe(200);
		const verified = (await verifyRes.json()) as {
			verifiedBy: string;
			verifiedAt: number;
			freshness: { state: string };
		};
		expect(verified.verifiedBy).toBe(userEmail);
		// The page was overdue (verified_at 2020-01-01); verifying it now resets the clock.
		expect(verified.freshness.state).toBe("fresh");

		// The stamp is written into the page's frontmatter (not just the denormalized
		// columns), so a subsequent read reflects it without needing an unrelated edit.
		const pageRes = await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await pageRes.json()) as { verified_by: string; content: string };
		expect(page.verified_by).toBe(userEmail);
		expect(page.content).toContain(`verified_by: ${userEmail}`);
	});

	it("verify_wiki_page records a revision, same as any other content edit", async () => {
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Revision Check", content: overdueContent() }),
		});
		const created = (await createRes.json()) as { slug: string };

		const before = await SELF.fetch(`http://localhost/api/wiki/${created.slug}/revisions`, {
			headers: authHeaders(token, slug),
		});
		const beforeRevisions = (await before.json()) as unknown[];

		await SELF.fetch(`http://localhost/api/wiki/${created.slug}/verify`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});

		const after = await SELF.fetch(`http://localhost/api/wiki/${created.slug}/revisions`, {
			headers: authHeaders(token, slug),
		});
		const afterRevisions = (await after.json()) as unknown[];
		expect(afterRevisions.length).toBe(beforeRevisions.length + 1);
	});

	it("POST /api/wiki/:slug/verify is rejected for a viewer", async () => {
		const roles = await seedWorkspaceRoles();
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ title: "Viewer Guard", content: overdueContent() }),
		});
		const created = (await createRes.json()) as { slug: string };

		const res = await SELF.fetch(`http://localhost/api/wiki/${created.slug}/verify`, {
			method: "POST",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
		});
		expect(res.status).toBe(403);
	});

	it("MCP verify_wiki_page stamps verified_at/verified_by, parity with REST", async () => {
		const created = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "MCP Verify Target", content: overdueContent() },
				authHeaders(token, slug)
			)
		);

		const result = mcpData<{ verifiedBy: string; freshness: { state: string } }>(
			await mcpCall(
				workspaceId,
				"verify_wiki_page",
				{ slug: created.slug },
				authHeaders(token, slug)
			)
		);
		expect(result.verifiedBy).toBe(userEmail);
		expect(result.freshness.state).toBe("fresh");
	});

	it("GET /api/wiki/search demotes a computed-stale page below a fresh page matching the same query", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Stale Deploy Guide",
				content: `${overdueContent()}\ndeploy keyword`,
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Fresh Deploy Guide",
				content: `${freshContent()}\ndeploy keyword`,
			}),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=deploy", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{
			title: string;
			freshness: { state: string } | null;
		}>;
		expect(results.map((r) => r.title)).toEqual(["Fresh Deploy Guide", "Stale Deploy Guide"]);
		expect(results[0].freshness?.state).toBe("fresh");
		expect(results[1].freshness?.state).toBe("stale");
	});

	it("GET /api/wiki/search demotes an explicitly status: deprecated page too", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Deprecated Onboarding",
				content: `${explicitStatusContent("deprecated")}\nonboardingkeyword`,
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Current Onboarding", content: "onboardingkeyword" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=onboardingkeyword", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title)).toEqual(["Current Onboarding", "Deprecated Onboarding"]);
	});

	it("GET /api/wiki/stale-pages lists computed-stale, unverified, and explicitly stale/deprecated pages, excluding fresh ones", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Overdue Page", content: overdueContent() }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Never Verified Page", content: unverifiedContent() }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Explicitly Stale Page",
				content: explicitStatusContent("stale"),
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Fresh Page", content: freshContent() }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "No Signal Page", content: "plain markdown" }),
		});

		// PROJ-489: 5 creates already used up this token's test-env rate limit
		// (wrangler.test.toml RATE_LIMIT_API_MAX=5) — reset before the read below.
		await env.DB.prepare("DELETE FROM rate_limit").run();
		const res = await SELF.fetch("http://localhost/api/wiki/stale-pages", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const results = (await res.json()) as Array<{ title: string }>;
		const titles = results.map((r) => r.title).sort();
		expect(titles).toEqual(["Explicitly Stale Page", "Never Verified Page", "Overdue Page"]);
	});

	it("MCP list_stale_pages returns the same result shape as REST", async () => {
		await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "MCP Overdue Page", content: overdueContent() },
			authHeaders(token, slug)
		);
		await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "MCP Fresh Page", content: freshContent() },
			authHeaders(token, slug)
		);

		const result = mcpData<Array<{ title: string }>>(
			await mcpCall(workspaceId, "list_stale_pages", {}, authHeaders(token, slug))
		);
		expect(result.map((r) => r.title)).toContain("MCP Overdue Page");
		expect(result.map((r) => r.title)).not.toContain("MCP Fresh Page");
	});
});
