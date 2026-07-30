import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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
			expect(created.url).toBe("/wiki?slug=weekly-updates");

			const getRes = await SELF.fetch("http://localhost/api/wiki/weekly-updates", {
				headers: authHeaders(token, slug),
			});
			const fetched = (await getRes.json()) as { url: string };
			expect(fetched.url).toBe("/wiki?slug=weekly-updates");

			const updateRes = await SELF.fetch("http://localhost/api/wiki/weekly-updates", {
				method: "PUT",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ content: "index v2" }),
			});
			const updated = (await updateRes.json()) as { url: string };
			expect(updated.url).toBe("/wiki?slug=weekly-updates");

			const listRes = await SELF.fetch("http://localhost/api/wiki", {
				headers: authHeaders(token, slug),
			});
			const list = (await listRes.json()) as Array<{ slug: string; url: string }>;
			expect(list.find((p) => p.slug === "weekly-updates")?.url).toBe("/wiki?slug=weekly-updates");

			const treeRes = await SELF.fetch("http://localhost/api/wiki/tree", {
				headers: authHeaders(token, slug),
			});
			const tree = (await treeRes.json()) as Array<{ slug: string; url: string }>;
			expect(tree.find((p) => p.slug === "weekly-updates")?.url).toBe("/wiki?slug=weekly-updates");
		});

		it("includes projectId in the url when the page is scoped to a project", async () => {
			const project = await seedProject(workspaceId);
			await seedGroupGrant(workspaceId, userId, project.id);
			const createRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ title: "Project Notes", content: "notes", projectId: project.id }),
			});
			const created = (await createRes.json()) as { url: string };
			expect(created.url).toBe(`/wiki?slug=project-notes&projectId=${project.id}`);
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

	// PROJ-486: freshness (R7, PROJ-489) hasn't landed — the field is present but null,
	// never fabricated.
	it("GET /api/wiki/search returns freshness: null (R7 not yet implemented)", async () => {
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

	// PROJ-486: type/tags/status are accepted for R6/R7 forward compatibility but not
	// yet implemented — passing them must not error or change results.
	it("GET /api/wiki/search ignores unsupported type/status filters instead of erroring", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Noop Filter Page", content: "wrangler" }),
		});
		const res = await SELF.fetch(
			"http://localhost/api/wiki/search?q=wrangler&type=guide&status=fresh",
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title)).toContain("Noop Filter Page");
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
		expect(await delRes.json()).toEqual({ ok: true, deletedCount: 1 });

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
		expect(await delRes.json()).toEqual({ ok: true, deletedCount: 3 });

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
		expect(updated.url).toContain("slug=product-roadmap");

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
		expect(updatedResult.url).toContain("slug=team-handbook");

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
