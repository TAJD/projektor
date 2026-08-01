import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { computeFreshness } from "../services/wiki-freshness";
import {
	authHeaders,
	seedFixture,
	seedGroupGrant,
	seedMember,
	seedProject,
	seedToken,
	seedUser,
	seedWorkspaceRoles,
} from "./helpers";

type JsonRpcResult<T = unknown> = { jsonrpc: "2.0"; id: unknown; result: T };
type JsonRpcError = {
	jsonrpc: "2.0";
	id: unknown;
	error: { code: number; message: string; data?: unknown };
};

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

	it("DELETE /api/wiki/:slug (default) trashes the page but leaves its R2 attachment in place until purge (PROJ-426/PROJ-496)", async () => {
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

		// PROJ-496: R2 cleanup moved to purge time — a soft-deleted page's attachment
		// object/row must still exist (e.g. so undelete leaves the page fully intact).
		expect(await env.R2.get(r2Key)).not.toBeNull();
		const row = await env.DB.prepare("SELECT id FROM attachments WHERE id = ?")
			.bind(attachmentId)
			.first();
		expect(row).not.toBeNull();
	});

	it("DELETE /api/wiki/:slug?cascade=true trashes the subtree but leaves R2 attachments in place until purge (PROJ-426/PROJ-496)", async () => {
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

		expect(await env.R2.get(parentFile.r2Key)).not.toBeNull();
		expect(await env.R2.get(childFile.r2Key)).not.toBeNull();
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
	let userId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
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

	it("POST /api/wiki rejects a slug containing '/' (PROJ-517, 400)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Nested", content: "v1", slug: "a/b" }),
		});
		expect(res.status).toBe(400);
	});

	it("PUT /api/wiki/:slug rejects renaming to a slug containing '/' (PROJ-517, 400)", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Delta", content: "d" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/delta", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "a/b" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/wiki falls back to an opaque slug for a symbol-only/non-Latin title whose derived slug would be empty (PROJ-517/512 finding 5)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "測試", content: "v1" }),
		});
		expect(res.status).toBe(201);
		const page = (await res.json()) as { slug: string; id: string };
		expect(page.slug).toMatch(/^page-[0-9a-f]{8}$/);

		const getRes = await SELF.fetch(`http://localhost/api/wiki/${page.slug}`, {
			headers: authHeaders(token, slug),
		});
		const fetched = (await getRes.json()) as { title: string };
		expect(fetched.title).toBe("測試");
	});

	it("POST /api/wiki falls back to an opaque slug for a title whose derived slug would exceed SlugSchema's 200-char max (PROJ-517/512 finding 5)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "a".repeat(300), content: "v1" }),
		});
		expect(res.status).toBe(201);
		const page = (await res.json()) as { slug: string };
		expect(page.slug).toMatch(/^page-[0-9a-f]{8}$/);
	});

	it("MCP create_wiki_page rejects a slug containing '/' (PROJ-517, REST/MCP parity)", async () => {
		const res = await mcpCall(
			workspaceId,
			"create_wiki_page",
			{ title: "Nested", content: "v1", slug: "a/b" },
			authHeaders(token, slug)
		);
		expect(isMcpError(res)).toBe(true);
		if (isMcpError(res)) expect(res.error.code).toBe(-32602);
	});

	it("MCP update_wiki_page rejects renaming to a slug containing '/' (PROJ-517, REST/MCP parity)", async () => {
		const created = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "Delta MCP", content: "d" },
				authHeaders(token, slug)
			)
		);

		const res = await mcpCall(
			workspaceId,
			"update_wiki_page",
			{ slug: created.slug, newSlug: "a/b" },
			authHeaders(token, slug)
		);
		expect(isMcpError(res)).toBe(true);
	});

	it("a slashy slug rewritten by the PROJ-517 backfill migration still resolves, and the old slug redirects (finding 1)", async () => {
		// Simulate a pre-PROJ-517 row that predates SlugSchema's no-slash rule by
		// inserting directly (SlugSchema would now reject this via the service layer).
		const pageId = crypto.randomUUID();
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content, parent_id, created_by_id, updated_by_id, created_at, updated_at)
			 VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?)`
		)
			.bind(
				pageId,
				workspaceId,
				"operations/admin-allow-list",
				"Admin Allow List",
				"content",
				userId,
				userId,
				now,
				now
			)
			.run();

		// Apply the same rewrite migration 0050 performs, since the fixture DB's
		// migrations already ran in beforeAll before this row existed.
		const redirectId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO wiki_redirects (id, workspace_id, old_slug, page_id, created_at) VALUES (?, ?, ?, ?, ?)`
		)
			.bind(redirectId, workspaceId, "operations/admin-allow-list", pageId, now)
			.run();
		await env.DB.prepare(`UPDATE wiki_pages SET slug = ? WHERE id = ?`)
			.bind("operations-admin-allow-list", pageId)
			.run();

		const newRes = await SELF.fetch("http://localhost/api/wiki/operations-admin-allow-list", {
			headers: authHeaders(token, slug),
		});
		expect(newRes.status).toBe(200);

		// Resolve via MCP's get_wiki_page, passing the old slug as a plain argument
		// (not a URL path segment) — sidesteps any router-level handling of an
		// encoded "/" and tests the redirect-fallback resolution itself.
		const oldPage = mcpData<{ slug: string }>(
			await mcpCall(
				workspaceId,
				"get_wiki_page",
				{ slug: "operations/admin-allow-list" },
				authHeaders(token, slug)
			)
		);
		expect(oldPage.slug).toBe("operations-admin-allow-list");
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
			const data = conflictResult.error.data as { currentRevisionId: string; diff: string };
			expect(data.currentRevisionId).toBe(currentLatest.id);
			// staleRevision snapshots the pre-edit content of the FIRST edit ("v1"); the
			// content the caller actually had is the NEXT revision's snapshot ("v2"), which
			// is the correct diff base — not staleRevision's own "v1".
			expect(data.diff).toContain("v2");
			expect(data.diff).toContain("v3");
		}
	});
});

// PROJ-492 (R10): revision diff endpoint + restore-via-update_wiki_page. Restore is
// deliberately NOT a dedicated endpoint — it's a client-side convenience that reads an
// old revision's content and re-submits it through update_wiki_page/PUT with a
// baseRevisionId, so it gets normal optimistic-locking/frontmatter/FTS/link-reindex
// treatment for free (see PR description for the design rationale).
describe("Wiki revision diff (PROJ-492)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

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
		return (await res.json()) as Array<{ id: string; created_at: number }>;
	}

	it("REST: diff against current defaults when `against` is omitted", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Diffable Doc", content: "line one\nline two" }),
		});
		await req("http://localhost/api/wiki/diffable-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "line one\nline THREE" }),
		});
		const [latest] = await getRevisions("diffable-doc");

		const res = await req(`http://localhost/api/wiki/diffable-doc/revisions/${latest.id}/diff`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { from: string; to: string; diff: string };
		expect(body.from).toBe(latest.id);
		expect(body.to).toBe("current");
		expect(body.diff).toContain("-line two");
		expect(body.diff).toContain("+line THREE");
	});

	it("REST: diff between two explicit revisions", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Multi Rev Doc", content: "v1" }),
		});
		await req("http://localhost/api/wiki/multi-rev-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		await req("http://localhost/api/wiki/multi-rev-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v3" }),
		});
		const [v2Revision, v1Revision] = await getRevisions("multi-rev-doc");

		const res = await req(
			`http://localhost/api/wiki/multi-rev-doc/revisions/${v1Revision.id}/diff?against=${v2Revision.id}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { diff: string };
		expect(body.diff).toContain("-v1");
		expect(body.diff).toContain("+v2");
	});

	it("REST: identical revisions diff to an empty string", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Unchanged Doc", content: "same" }),
		});
		await req("http://localhost/api/wiki/unchanged-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "same" }),
		});
		const [latest] = await getRevisions("unchanged-doc");

		const res = await req(
			`http://localhost/api/wiki/unchanged-doc/revisions/${latest.id}/diff?against=current`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { diff: string }).diff).toBe("");
	});

	it("REST: an unknown `against` revision id 404s", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Unknown Against Doc", content: "v1" }),
		});
		await req("http://localhost/api/wiki/unknown-against-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		const [latest] = await getRevisions("unknown-against-doc");

		const res = await req(
			`http://localhost/api/wiki/unknown-against-doc/revisions/${latest.id}/diff?against=${crypto.randomUUID()}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(404);
	});

	it("REST: an unknown revisionId 404s", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "No Such Revision Doc", content: "v1" }),
		});

		const res = await req(
			`http://localhost/api/wiki/no-such-revision-doc/revisions/${crypto.randomUUID()}/diff`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(404);
	});

	it("MCP: get_wiki_revision_diff parity with REST", async () => {
		const created = mcpData<{ slug: string }>(
			await mcp("create_wiki_page", { title: "MCP Diff Doc", content: "alpha" })
		);
		await mcp("update_wiki_page", { slug: created.slug, content: "beta" });
		const [latest] = mcpData<Array<{ id: string }>>(
			await mcp("list_wiki_revisions", { slug: created.slug })
		);

		const result = mcpData<{ from: string; to: string; diff: string }>(
			await mcp("get_wiki_revision_diff", { slug: created.slug, revisionId: latest.id })
		);
		expect(result.to).toBe("current");
		expect(result.diff).toContain("-alpha");
		expect(result.diff).toContain("+beta");
	});

	it("restore is a plain update_wiki_page call with the old revision's content — creates a new revision, never rewrites history", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Restorable Doc", content: "original content" }),
		});
		await req("http://localhost/api/wiki/restorable-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "mistaken edit" }),
		});
		const [latest] = await getRevisions("restorable-doc");

		// Fetch the old revision's content (what the restore UI does) and resubmit it.
		const revRes = await req(`http://localhost/api/wiki/restorable-doc/revisions/${latest.id}`, {
			headers: authHeaders(token, slug),
		});
		const oldRevision = (await revRes.json()) as { content: string };
		expect(oldRevision.content).toBe("original content");

		const restoreRes = await req("http://localhost/api/wiki/restorable-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				content: oldRevision.content,
				baseRevisionId: latest.id,
				summary: `Restored from revision ${latest.id}`,
			}),
		});
		expect(restoreRes.status).toBe(200);

		const pageRes = await req("http://localhost/api/wiki/restorable-doc", {
			headers: authHeaders(token, slug),
		});
		expect(((await pageRes.json()) as { content: string }).content).toBe("original content");

		// Restoring created a NEW (third) revision snapshotting the pre-restore "mistaken
		// edit" content — it never rewrote or deleted the original "original content"
		// revision, which is still present in history.
		const revisions = await getRevisions("restorable-doc");
		expect(revisions.length).toBe(2);
		expect(revisions[0].id).not.toBe(latest.id);
		expect(revisions.map((r) => r.id)).toContain(latest.id);
	});

	it("restore with a baseRevisionId that went stale while history was open is a 409, not a silent overwrite", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Raced Restore Doc", content: "original content" }),
		});
		await req("http://localhost/api/wiki/raced-restore-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "mistaken edit" }),
		});
		// What the restore UI froze when the history panel loaded.
		const [staleLatest] = await getRevisions("raced-restore-doc");

		// Someone else saves before the user clicks Restore.
		await req("http://localhost/api/wiki/raced-restore-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "a colleague's edit" }),
		});

		const restoreRes = await req("http://localhost/api/wiki/raced-restore-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				content: "original content",
				baseRevisionId: staleLatest.id,
				summary: "Restored from an old revision",
			}),
		});
		expect(restoreRes.status).toBe(409);
		const conflict = (await restoreRes.json()) as { currentRevisionId: string; diff: string };
		expect(conflict.currentRevisionId).not.toBe(staleLatest.id);

		// The colleague's edit survives untouched and no restore revision was written.
		const pageRes = await req("http://localhost/api/wiki/raced-restore-doc", {
			headers: authHeaders(token, slug),
		});
		expect(((await pageRes.json()) as { content: string }).content).toBe("a colleague's edit");
		expect((await getRevisions("raced-restore-doc")).length).toBe(2);
	});

	it("restoring a revision whose frontmatter no longer validates fails cleanly — 400, no partial write", async () => {
		await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Legacy Frontmatter Doc", content: "first body" }),
		});
		await req("http://localhost/api/wiki/legacy-frontmatter-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "second body" }),
		});
		const [latest] = await getRevisions("legacy-frontmatter-doc");

		// Simulate a snapshot taken before R6's frontmatter validation existed, carrying a
		// `status` value outside today's closed enum. Written straight to the revision row
		// because the API (correctly) refuses to create such content in the first place.
		await env.DB.prepare("UPDATE wiki_revisions SET content = ? WHERE id = ?")
			.bind("---\nstatus: archived\n---\n\nlegacy body", latest.id)
			.run();

		const revRes = await req(
			`http://localhost/api/wiki/legacy-frontmatter-doc/revisions/${latest.id}`,
			{ headers: authHeaders(token, slug) }
		);
		const oldRevision = (await revRes.json()) as { content: string };

		const restoreRes = await req("http://localhost/api/wiki/legacy-frontmatter-doc", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				content: oldRevision.content,
				baseRevisionId: latest.id,
				summary: "Restored from a legacy revision",
			}),
		});
		expect(restoreRes.status).toBe(400);

		// The live page is untouched and no half-written revision was left behind.
		const pageRes = await req("http://localhost/api/wiki/legacy-frontmatter-doc", {
			headers: authHeaders(token, slug),
		});
		expect(((await pageRes.json()) as { content: string }).content).toBe("second body");
		expect((await getRevisions("legacy-frontmatter-doc")).length).toBe(1);
	});
});

// PROJ-490: section-addressed patch operations (R8). Disjoint-section writes must
// never conflict — that's the headline behavior a naive whole-page baseRevisionId
// check would break.
describe("Wiki patch operations (PROJ-490)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	// Same rate-limit escape hatch as the PROJ-484 describe block above.
	async function req(url: string, opts?: RequestInit) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return SELF.fetch(url, opts);
	}

	async function mcp<T>(name: string, args: unknown) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return mcpCall<T>(workspaceId, name, args, authHeaders(token, slug));
	}

	async function createPage(pageSlug: string, title: string, content: string) {
		const res = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title, content, slug: pageSlug }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string; slug: string };
	}

	async function getPage(pageSlug: string) {
		const res = await req(`http://localhost/api/wiki/${pageSlug}`, {
			headers: authHeaders(token, slug),
		});
		return (await res.json()) as { content: string };
	}

	const TWO_SECTIONS = "## Alpha\nAlpha body.\n\n## Beta\nBeta body.\n";

	it("REST: append_to_section adds text at the end of the target section only", async () => {
		await createPage("patch-append", "Patch Append", TWO_SECTIONS);
		const res = await req("http://localhost/api/wiki/patch-append", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "Extra alpha line.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(200);
		const page = await getPage("patch-append");
		expect(page.content).toContain("Alpha body.\n\nExtra alpha line.");
		expect(page.content).toContain("## Beta\nBeta body.");
	});

	it("REST: replace_section replaces the section body, keeping the heading", async () => {
		await createPage("patch-replace", "Patch Replace", TWO_SECTIONS);
		const res = await req("http://localhost/api/wiki/patch-replace", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "replace_section",
				heading: "Alpha",
				text: "Replaced alpha body.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(200);
		const page = await getPage("patch-replace");
		expect(page.content).toContain("## Alpha\nReplaced alpha body.");
		expect(page.content).not.toContain("Alpha body.\n");
		expect(page.content).toContain("## Beta\nBeta body.");
	});

	it("REST: insert_after_heading inserts content directly under the heading, before the existing body", async () => {
		await createPage("patch-insert", "Patch Insert", TWO_SECTIONS);
		const res = await req("http://localhost/api/wiki/patch-insert", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "insert_after_heading",
				heading: "Alpha",
				text: "Inserted line.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(200);
		const page = await getPage("patch-insert");
		const inserted = page.content.indexOf("Inserted line.");
		const body = page.content.indexOf("Alpha body.");
		expect(inserted).toBeGreaterThan(-1);
		expect(inserted).toBeLessThan(body);
	});

	it("REST: append_to_page appends at the very end regardless of section structure", async () => {
		await createPage("patch-append-page", "Patch Append Page", TWO_SECTIONS);
		const res = await req("http://localhost/api/wiki/patch-append-page", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_page",
				text: "## Gamma\nGamma body.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(200);
		const page = await getPage("patch-append-page");
		expect(page.content.trim().endsWith("## Gamma\nGamma body.")).toBe(true);
	});

	it("REST: patch creates a revision, restorable via list_wiki_revisions", async () => {
		await createPage("patch-revision", "Patch Revision", TWO_SECTIONS);
		await req("http://localhost/api/wiki/patch-revision", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "More alpha.",
				baseRevisionId: null,
				summary: "added alpha detail",
			}),
		});
		const revRes = await req("http://localhost/api/wiki/patch-revision/revisions", {
			headers: authHeaders(token, slug),
		});
		const revisions = (await revRes.json()) as Array<{ id: string; summary: string | null }>;
		expect(revisions).toHaveLength(1);
		expect(revisions[0].summary).toBe("added alpha detail");

		const snapshotRes = await req(
			`http://localhost/api/wiki/patch-revision/revisions/${revisions[0].id}`,
			{ headers: authHeaders(token, slug) }
		);
		const snapshot = (await snapshotRes.json()) as { content: string };
		expect(snapshot.content).toBe(TWO_SECTIONS);
	});

	it("REST: unknown heading is rejected with a structured error listing current headings", async () => {
		await createPage("patch-missing-heading", "Patch Missing Heading", TWO_SECTIONS);
		const res = await req("http://localhost/api/wiki/patch-missing-heading", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Gamma",
				text: "x",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; currentHeadings: string[] };
		expect(body.currentHeadings).toEqual(["Alpha", "Beta"]);
	});

	it("REST: disjoint-section writes never conflict — two agents patching different sections against a stale baseRevisionId both succeed", async () => {
		await createPage("patch-disjoint", "Patch Disjoint", TWO_SECTIONS);
		const revRes = await req("http://localhost/api/wiki/patch-disjoint/revisions", {
			headers: authHeaders(token, slug),
		});
		// No revisions yet (page just created) — base is null.
		expect(((await revRes.json()) as unknown[]).length).toBe(0);

		// Agent A patches Alpha.
		const resA = await req("http://localhost/api/wiki/patch-disjoint", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "From agent A.",
				baseRevisionId: null,
			}),
		});
		expect(resA.status).toBe(200);

		// Agent B still holds the same stale baseRevisionId (null — pre-A's edit) but
		// targets the disjoint Beta section. This must succeed, not conflict, even
		// though the page's overall revision has advanced since A's write.
		const resB = await req("http://localhost/api/wiki/patch-disjoint", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Beta",
				text: "From agent B.",
				baseRevisionId: null,
			}),
		});
		expect(resB.status).toBe(200);

		const page = await getPage("patch-disjoint");
		expect(page.content).toContain("Alpha body.\n\nFrom agent A.");
		expect(page.content).toContain("Beta body.\n\nFrom agent B.");
	});

	it("REST: a same-section conflict is rejected with a structured diff", async () => {
		await createPage("patch-conflict", "Patch Conflict", TWO_SECTIONS);

		// Agent A patches Alpha from the null base.
		await req("http://localhost/api/wiki/patch-conflict", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "From agent A.",
				baseRevisionId: null,
			}),
		});

		// Agent B still holds the stale null base but targets the SAME Alpha section —
		// this must conflict.
		const res = await req("http://localhost/api/wiki/patch-conflict", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "From agent B.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; currentRevisionId: string; diff: string };
		expect(typeof body.currentRevisionId).toBe("string");
		expect(body.diff).toContain("From agent A.");
	});

	it("REST: a section deleted since baseRevisionId surfaces as a not-found error, not a silent conflict", async () => {
		await createPage("patch-deleted-section", "Patch Deleted Section", TWO_SECTIONS);
		const revRes = await req("http://localhost/api/wiki/patch-deleted-section/revisions", {
			headers: authHeaders(token, slug),
		});
		expect(((await revRes.json()) as unknown[]).length).toBe(0);

		// Someone replaces the whole page, removing the Beta heading entirely.
		await req("http://localhost/api/wiki/patch-deleted-section", {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "## Alpha\nAlpha body.\n" }),
		});

		const res = await req("http://localhost/api/wiki/patch-deleted-section", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Beta",
				text: "x",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { currentHeadings: string[] };
		expect(body.currentHeadings).toEqual(["Alpha"]);
	});

	it("REST: patch preserves existing YAML frontmatter untouched", async () => {
		const content = "---\ntype: runbook\nstatus: current\n---\n\n## Alpha\nAlpha body.\n";
		await createPage("patch-frontmatter", "Patch Frontmatter", content);
		const res = await req("http://localhost/api/wiki/patch-frontmatter", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "More.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(200);
		const getRes = await req("http://localhost/api/wiki/patch-frontmatter", {
			headers: authHeaders(token, slug),
		});
		const page = (await getRes.json()) as { content: string; type: string; status: string };
		expect(page.content).toContain("type: runbook");
		expect(page.type).toBe("runbook");
		expect(page.status).toBe("current");
	});

	it("REST: viewer role cannot patch a workspace-level page", async () => {
		const roles = await seedWorkspaceRoles();
		await env.DB.prepare("DELETE FROM rate_limit").run();
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ title: "Patch Viewer", content: TWO_SECTIONS, slug: "patch-viewer" }),
		});
		expect(createRes.status).toBe(201);

		await env.DB.prepare("DELETE FROM rate_limit").run();
		const res = await SELF.fetch("http://localhost/api/wiki/patch-viewer", {
			method: "PATCH",
			headers: authHeaders(roles.viewer.token, roles.workspace.slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "x",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(403);
	});

	it("REST: baseRevisionId that doesn't belong to the page is rejected with a validation error", async () => {
		await createPage("patch-garbage-base", "Patch Garbage Base", TWO_SECTIONS);
		const res = await req("http://localhost/api/wiki/patch-garbage-base", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "x",
				baseRevisionId: crypto.randomUUID(),
			}),
		});
		expect(res.status).toBe(400);
	});

	// PROJ-524: append_to_page skips the *conflict* check for baseRevisionId (append is
	// commutative), but still must validate the id belongs to the page — same as the
	// section-addressed ops above — so a caller confused about which page it's targeting
	// gets a signal instead of silent acceptance.
	it("REST: append_to_page rejects a baseRevisionId that doesn't belong to the page", async () => {
		await createPage("patch-append-garbage-base", "Patch Append Garbage Base", TWO_SECTIONS);
		const res = await req("http://localhost/api/wiki/patch-append-garbage-base", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_page",
				text: "Gamma body.",
				baseRevisionId: crypto.randomUUID(),
			}),
		});
		expect(res.status).toBe(400);
	});

	it("REST: append_to_page accepts a baseRevisionId that DOES belong to the page, even though it's stale (staleness isn't rejected for this op)", async () => {
		await createPage("patch-append-stale-base", "Patch Append Stale Base", TWO_SECTIONS);
		const firstRes = await req("http://localhost/api/wiki/patch-append-stale-base", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "First edit.",
				baseRevisionId: null,
			}),
		});
		expect(firstRes.status).toBe(200);
		const revisions = (await (
			await req("http://localhost/api/wiki/patch-append-stale-base/revisions", {
				headers: authHeaders(token, slug),
			})
		).json()) as Array<{ id: string }>;

		const res = await req("http://localhost/api/wiki/patch-append-stale-base", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_page",
				text: "Appended after stale base.",
				baseRevisionId: revisions[0].id,
			}),
		});
		expect(res.status).toBe(200);
		const page = await getPage("patch-append-stale-base");
		expect(page.content.trim().endsWith("Appended after stale base.")).toBe(true);
	});

	it("MCP: patch_wiki_page parity — disjoint sections don't conflict, same section does", async () => {
		const created = mcpData<{ slug: string }>(
			await mcp("create_wiki_page", { title: "MCP Patch Doc", content: TWO_SECTIONS })
		);

		const okA = await mcp("patch_wiki_page", {
			slug: created.slug,
			op: "append_to_section",
			heading: "Alpha",
			text: "From MCP agent A.",
			baseRevisionId: null,
		});
		expect(isMcpError(okA)).toBe(false);

		const okB = await mcp("patch_wiki_page", {
			slug: created.slug,
			op: "append_to_section",
			heading: "Beta",
			text: "From MCP agent B.",
			baseRevisionId: null,
		});
		expect(isMcpError(okB)).toBe(false);

		const conflict = await mcp("patch_wiki_page", {
			slug: created.slug,
			op: "append_to_section",
			heading: "Alpha",
			text: "From MCP agent C.",
			baseRevisionId: null,
		});
		expect(isMcpError(conflict)).toBe(true);
		if (isMcpError(conflict)) {
			expect(conflict.error.code).toBe(-32000);
			const data = conflict.error.data as { currentRevisionId: string };
			expect(typeof data.currentRevisionId).toBe("string");
		}

		const missingHeading = await mcp("patch_wiki_page", {
			slug: created.slug,
			op: "replace_section",
			heading: "Nope",
			text: "x",
			baseRevisionId: null,
		});
		expect(isMcpError(missingHeading)).toBe(true);
		if (isMcpError(missingHeading)) {
			const data = missingHeading.error.data as { currentHeadings: string[] };
			expect(data.currentHeadings).toEqual(["Alpha", "Beta"]);
		}
	});

	// PROJ-523: the sibling ambiguous-heading case is a ValidationError, not a
	// NotFoundError — before PROJ-508's error.data plumbing it collapsed to a bare
	// "Invalid params" over MCP, dropping the duplicate-heading detail REST callers
	// got via body.error.formErrors. Twin of the REST test below.
	it("MCP: patch_wiki_page rejects an ambiguous heading with formErrors in error.data", async () => {
		const created = mcpData<{ slug: string }>(
			await mcp("create_wiki_page", {
				title: "MCP Patch Ambiguous",
				content: "# Notes\nOne.\n\n## Other\nx\n\n## Notes\nTwo.\n",
			})
		);

		const result = await mcp("patch_wiki_page", {
			slug: created.slug,
			op: "replace_section",
			heading: "Notes",
			text: "Replaced.",
			baseRevisionId: null,
		});
		expect(isMcpError(result)).toBe(true);
		if (isMcpError(result)) {
			expect(result.error.code).toBe(-32602);
			expect(result.error.message).toContain("Invalid params");
			expect(result.error.message).toContain("ambiguous");
			const data = result.error.data as {
				formErrors: string[];
				fieldErrors: Record<string, string[]>;
			};
			expect(data.formErrors.join(" ")).toContain("ambiguous");
			expect(data.fieldErrors.heading).toEqual(["h1", "h2"]);
		}
	});

	// PROJ-490: `#` lines only start a section in ordinary block context. A shell
	// comment in a fenced code block is the most common line in a runbook — treating
	// it as a heading would end the enclosing section mid-fence and a replace would
	// eat the opening fence, leaving an orphaned closing one.
	it("REST: a `#` line inside a fenced code block is not a heading", async () => {
		const content = "## Setup\n\n```bash\n# install deps\npnpm i\n```\n\n## Usage\nUse it.\n";
		await createPage("patch-fenced", "Patch Fenced", content);

		const missing = await req("http://localhost/api/wiki/patch-fenced", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "install deps",
				text: "x",
				baseRevisionId: null,
			}),
		});
		expect(missing.status).toBe(404);
		const body = (await missing.json()) as { currentHeadings: string[] };
		expect(body.currentHeadings).toEqual(["Setup", "Usage"]);

		const res = await req("http://localhost/api/wiki/patch-fenced", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "replace_section",
				heading: "Setup",
				text: "Replaced.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(200);
		const page = await getPage("patch-fenced");
		// The whole fenced block belonged to Setup, so it goes with the replaced body —
		// intact, not shredded into an orphan closing fence.
		expect(page.content).not.toContain("pnpm i");
		expect(page.content).not.toContain("```");
		expect(page.content).toContain("## Setup\nReplaced.");
		expect(page.content).toContain("## Usage\nUse it.");
	});

	it("REST: a `#` line inside the YAML frontmatter block is not a heading", async () => {
		const content =
			"---\ntype: runbook\n# a yaml comment\nstatus: current\n---\n\n## Alpha\nAlpha body.\n";
		await createPage("patch-fm-comment", "Patch FM Comment", content);
		const res = await req("http://localhost/api/wiki/patch-fm-comment", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "a yaml comment",
				text: "x",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { currentHeadings: string[] };
		expect(body.currentHeadings).toEqual(["Alpha"]);
	});

	it("REST: a heading appearing twice is rejected as ambiguous rather than silently patching the first", async () => {
		const content = "# Notes\nOne.\n\n## Other\nx\n\n## Notes\nTwo.\n";
		await createPage("patch-ambiguous", "Patch Ambiguous", content);
		const res = await req("http://localhost/api/wiki/patch-ambiguous", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "replace_section",
				heading: "Notes",
				text: "Replaced.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { formErrors: string[]; fieldErrors: Record<string, string[]> };
		};
		expect(body.error.formErrors.join(" ")).toContain("ambiguous");
		expect(body.error.fieldErrors.heading).toEqual(["h1", "h2"]);
		// Nothing was written.
		expect((await getPage("patch-ambiguous")).content).toBe(content);
	});

	it("REST: repeated insert_after_heading does not accumulate blank lines", async () => {
		await createPage("patch-blanklines", "Patch Blank Lines", TWO_SECTIONS);
		for (const text of ["First.", "Second."]) {
			const revRes = await req("http://localhost/api/wiki/patch-blanklines/revisions", {
				headers: authHeaders(token, slug),
			});
			const revisions = (await revRes.json()) as Array<{ id: string }>;
			const res = await req("http://localhost/api/wiki/patch-blanklines", {
				method: "PATCH",
				headers: authHeaders(token, slug),
				body: JSON.stringify({
					op: "insert_after_heading",
					heading: "Alpha",
					text,
					baseRevisionId: revisions[0]?.id ?? null,
				}),
			});
			expect(res.status).toBe(200);
		}
		const page = await getPage("patch-blanklines");
		expect(page.content).not.toContain("\n\n\n");
		expect(page.content).toContain("## Alpha\nSecond.\n\nFirst.\n\nAlpha body.");
	});

	it("REST: patch does not stamp verified_at as a side effect", async () => {
		const content = "---\ntype: runbook\n---\n\n## Alpha\nAlpha body.\n";
		await createPage("patch-no-verify", "Patch No Verify", content);
		const res = await req("http://localhost/api/wiki/patch-no-verify", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				op: "append_to_section",
				heading: "Alpha",
				text: "More.",
				baseRevisionId: null,
			}),
		});
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT verified_at, verified_by FROM wiki_pages WHERE slug = ?"
		)
			.bind("patch-no-verify")
			.first<{ verified_at: number | null; verified_by: string | null }>();
		expect(row?.verified_at).toBeNull();
		expect(row?.verified_by).toBeNull();
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

	it("PROJ-517/512: a multi-segment /wiki/ URL is never indexed against the first segment's page", async () => {
		const operations = await createPage("Operations", "contents");
		await createPage("Runbook", `[Runbook](/wiki/${operations.slug}/admin-allow-list)`);

		const res = await SELF.fetch(`http://localhost/api/wiki/${operations.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		const backlinks = (await res.json()) as Array<{ slug: string }>;
		expect(backlinks).toEqual([]);
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

describe("Wiki write atomicity (PROJ-511)", () => {
	let token: string;
	let slug: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
	});

	it("a slug race during create leaves wiki_links with only the winner's link, never a partial write", async () => {
		// createWikiPage's assertSlugAvailable-then-insert isn't atomic (services/wiki.ts):
		// two concurrent creates with the same title/slug can both pass the availability
		// check, so one loses to a UNIQUE constraint failure inside the ctx.db.batch() call
		// itself. PROJ-511 batches the page insert, its wiki_fts row, and its wiki_links
		// rows together, so the loser's batch must fail as a whole — never leaving a
		// dangling wiki_links row for a page insert that didn't happen.
		const [resA, resB] = await Promise.all([
			SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({
					title: "Atomicity Race Page",
					content: "see [[Race Target Alpha]]",
				}),
			}),
			SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(token, slug),
				body: JSON.stringify({ title: "Atomicity Race Page", content: "see [[Race Target Beta]]" }),
			}),
		]);
		const statuses = [resA.status, resB.status].sort();
		expect(statuses).toEqual([201, 409]);

		const brokenRes = await SELF.fetch("http://localhost/api/wiki/broken-links", {
			headers: authHeaders(token, slug),
		});
		const broken = (await brokenRes.json()) as Array<{ targetTitle: string }>;
		expect(broken).toHaveLength(1);
		expect(["Race Target Alpha", "Race Target Beta"]).toContain(broken[0].targetTitle);
	});

	it("a failed rename (slug conflict) leaves the page's content, wiki_links, and wiki_fts untouched", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Atomic Runbook", content: "how to page" }),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Atomic Existing", content: "x" }),
		});
		const sourceRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Atomic Source", content: "see [[Atomic Runbook]]" }),
		});
		const source = (await sourceRes.json()) as { slug: string };

		await env.DB.prepare("DELETE FROM rate_limit").run();
		const updateRes = await SELF.fetch(`http://localhost/api/wiki/${source.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "atomic-existing", content: "no longer links anywhere" }),
		});
		expect(updateRes.status).toBe(409);

		await env.DB.prepare("DELETE FROM rate_limit").run();
		const pageRes = await SELF.fetch(`http://localhost/api/wiki/${source.slug}`, {
			headers: authHeaders(token, slug),
		});
		expect(await pageRes.json()).toEqual(
			expect.objectContaining({ content: "see [[Atomic Runbook]]" })
		);

		await env.DB.prepare("DELETE FROM rate_limit").run();
		const backlinksRes = await SELF.fetch("http://localhost/api/wiki/atomic-runbook/backlinks", {
			headers: authHeaders(token, slug),
		});
		const backlinks = (await backlinksRes.json()) as Array<{ slug: string }>;
		expect(backlinks.map((b) => b.slug)).toEqual(["atomic-source"]);

		await env.DB.prepare("DELETE FROM rate_limit").run();
		const searchRes = await SELF.fetch("http://localhost/api/wiki/search?q=links+anywhere", {
			headers: authHeaders(token, slug),
		});
		expect(await searchRes.json()).toEqual([]);
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

	// PROJ-489: verifying rewrites the whole content (frontmatter stamp + body), so it must
	// stamp the CURRENT content — a stale read would silently revert the edit before it.
	it("POST /api/wiki/:slug/verify stamps on top of the latest content, never a stale snapshot", async () => {
		const createRes = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Edited Then Verified", content: overdueContent() }),
		});
		const created = (await createRes.json()) as { slug: string };

		await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: `${overdueContent()}\n\nBrand new paragraph.` }),
		});

		await SELF.fetch(`http://localhost/api/wiki/${created.slug}/verify`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});

		const pageRes = await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await pageRes.json()) as { content: string; verified_by: string };
		expect(page.content).toContain("Brand new paragraph.");
		expect(page.verified_by).toBe(userEmail);
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

	// PROJ-515: decided to NOT demote "unverified" (verify_interval declared, never
	// verified) in search ranking — only in list_stale_pages (the maintenance queue).
	// A freshly authored page that opts into verification tracking shouldn't rank worse
	// than a legacy page with no frontmatter at all just for declaring an interval.
	it("GET /api/wiki/search does NOT demote an unverified page below a lower-relevance page with no freshness signal", async () => {
		// If "unverified" were still in the demotion tier, this page would sort AFTER
		// "No Signal" below regardless of relevance, the same way a stale/deprecated page
		// is forced below a fresh one in the tests above. Giving it the stronger (title)
		// match proves the opposite: bm25 alone decides the order now.
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Securitypolicykeyword Runbook",
				content: unverifiedContent(),
			}),
		});
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "No Signal Page",
				content: "buried mention of securitypolicykeyword in the body",
			}),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=securitypolicykeyword", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{
			title: string;
			freshness: { state: string } | null;
		}>;
		expect(results.map((r) => r.title)).toEqual([
			"Securitypolicykeyword Runbook",
			"No Signal Page",
		]);
		expect(results[0].freshness?.state).toBe("unverified");
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

// PROJ-491 (R9): workspace-level page templates — `template: true` frontmatter,
// create_wiki_page's templateSlug, and the list_wiki_templates picker. REST/MCP parity
// throughout, same as the other frontmatter-driven features above.
describe("Wiki page templates (PROJ-491)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	const TEMPLATE_CONTENT = [
		"---",
		"type: runbook",
		"status: draft",
		"template: true",
		"---",
		"# Runbook: [Title]",
		"",
		"## Steps",
	].join("\n");

	async function createTemplate() {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Runbook Template", content: TEMPLATE_CONTENT }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string; slug: string; isTemplate: boolean };
	}

	it("REST: frontmatter template:true denormalizes into isTemplate on create", async () => {
		const created = await createTemplate();
		expect(created.isTemplate).toBe(true);

		const getRes = await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await getRes.json()) as { is_template: boolean };
		expect(page.is_template).toBe(true);
	});

	it("REST: create_wiki_page with templateSlug seeds content and strips template:true", async () => {
		await createTemplate();

		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Deploy Runbook", templateSlug: "runbook-template" }),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { slug: string; isTemplate: boolean; type: string };
		// The seeded page keeps the template's other frontmatter (type) but is not itself
		// a template — only the `template` key is stripped.
		expect(created.isTemplate).toBe(false);
		expect(created.type).toBe("runbook");

		const getRes = await SELF.fetch(`http://localhost/api/wiki/${created.slug}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await getRes.json()) as { content: string; is_template: boolean };
		expect(page.content).toContain("## Steps");
		expect(page.content).not.toContain("template: true");
		expect(page.is_template).toBe(false);
	});

	it("MCP: create_wiki_page with templateSlug has parity with REST", async () => {
		await createTemplate();

		const result = mcpData<{ isTemplate: boolean; type: string }>(
			await mcpCall(
				workspaceId,
				"create_wiki_page",
				{ title: "MCP Deploy Runbook", templateSlug: "runbook-template" },
				authHeaders(token, slug)
			)
		);
		expect(result.isTemplate).toBe(false);
		expect(result.type).toBe("runbook");
	});

	it("rejects templateSlug that does not resolve to any page (not a silent blank fallback)", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Orphan Page", templateSlug: "does-not-exist" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects templateSlug pointing at a page that isn't flagged template:true", async () => {
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Ordinary Page", content: "# Just a page" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Bad Seed", templateSlug: "ordinary-page" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects content and templateSlug provided together", async () => {
		await createTemplate();

		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Ambiguous Page",
				content: "some content",
				templateSlug: "runbook-template",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("search_wiki excludes template pages by default", async () => {
		await createTemplate();
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Runbook For Deploys", content: "# Runbook body content" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/search?q=Runbook", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title)).toContain("Runbook For Deploys");
		expect(results.map((r) => r.title)).not.toContain("Runbook Template");
	});

	// PROJ-525: listWikiPages/GET /api/wiki previously had no is_template exclusion,
	// unlike search_wiki and listStaleWikiPages above — so a type=runbook filter listed
	// "Runbook Template" alongside real runbook pages.
	it("GET /api/wiki excludes template pages by default, matching search_wiki/list_stale_pages", async () => {
		await createTemplate();
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Ordinary Runbook", content: "# Not a template" }),
		});

		const defaultRes = await SELF.fetch("http://localhost/api/wiki", {
			headers: authHeaders(token, slug),
		});
		const defaultResults = (await defaultRes.json()) as Array<{ title: string }>;
		expect(defaultResults.map((r) => r.title)).toContain("Ordinary Runbook");
		expect(defaultResults.map((r) => r.title)).not.toContain("Runbook Template");

		const includedRes = await SELF.fetch("http://localhost/api/wiki?includeTemplates=true", {
			headers: authHeaders(token, slug),
		});
		const includedResults = (await includedRes.json()) as Array<{ title: string }>;
		expect(includedResults.map((r) => r.title)).toContain("Runbook Template");
	});

	it("list_stale_pages excludes template pages even with an overdue verify_interval", async () => {
		const overdueTemplateContent = [
			"---",
			"template: true",
			"verify_interval: 30",
			"verified_at: 2020-01-01",
			"---",
			"# Stale-looking template",
		].join("\n");
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Overdue Template", content: overdueTemplateContent }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/stale-pages", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title)).not.toContain("Overdue Template");
	});

	it("REST GET /api/wiki/templates lists only template-flagged pages", async () => {
		await createTemplate();
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Regular Page", content: "# Not a template" }),
		});

		const res = await SELF.fetch("http://localhost/api/wiki/templates", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const results = (await res.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title)).toEqual(["Runbook Template"]);
	});

	it("rejects a page slugged 'templates' — it would be shadowed by GET /api/wiki/templates", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Templates", slug: "templates", content: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("MCP list_wiki_templates has parity with REST", async () => {
		await createTemplate();

		const result = mcpData<Array<{ title: string }>>(
			await mcpCall(workspaceId, "list_wiki_templates", {}, authHeaders(token, slug))
		);
		expect(result.map((r) => r.title)).toEqual(["Runbook Template"]);
	});
});

// PROJ-491 (R9): createWorkspace seeds the three built-in templates under a "Templates"
// parent page — exercised against the real service (not the seedWorkspace test helper,
// which bypasses createWorkspace entirely) so this only runs where it matters.
describe("Wiki built-in template seeding on workspace creation (PROJ-491)", () => {
	it("seeds a Templates parent page plus runbook/adr/spec templates", async () => {
		const fixture = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(fixture.token, fixture.workspace.slug);
		const newSlug = `seed-test-${crypto.randomUUID().slice(0, 8)}`;

		const created = mcpData<{ id: string; slug: string }>(
			await mcpCall(
				fixture.workspace.id,
				"create_workspace",
				{ slug: newSlug, name: "Seed Test" },
				ownerHeaders
			)
		);

		const newToken = await seedToken(created.id, fixture.user.id);
		const newHeaders = authHeaders(newToken, created.slug);

		const listRes = await SELF.fetch("http://localhost/api/wiki/templates", {
			headers: newHeaders,
		});
		expect(listRes.status).toBe(200);
		const templates = (await listRes.json()) as Array<{ title: string; type: string | null }>;
		expect(templates.map((t) => t.title).sort()).toEqual([
			"ADR Template",
			"Runbook Template",
			"Spec Template",
		]);

		const treeRes = await SELF.fetch("http://localhost/api/wiki/tree", { headers: newHeaders });
		const tree = (await treeRes.json()) as Array<{
			title: string;
			slug: string;
			children: unknown[];
		}>;
		const templatesNode = tree.find((n) => n.title === "Templates");
		expect(templatesNode?.children.length).toBe(3);

		// The seeded parent must stay reachable by slug: GET /api/wiki/templates is the
		// template-list endpoint, so a parent slugged "templates" would be shadowed by it
		// and the page would never render.
		const parentRes = await SELF.fetch(`http://localhost/api/wiki/${templatesNode?.slug}`, {
			headers: newHeaders,
		});
		expect(parentRes.status).toBe(200);
		expect(((await parentRes.json()) as { title: string }).title).toBe("Templates");
	});

	// PROJ-522: the seeded "Templates" parent is a real, non-template, browsable page —
	// unlike the three template pages under it (deliberately search-excluded) it needs a
	// wiki_fts mirror row like every other write path maintains, or it's invisible to
	// search_wiki until someone happens to edit it.
	it("the seeded Templates parent page is findable via search_wiki", async () => {
		const fixture = await seedFixture({ role: "owner" });
		const ownerHeaders = authHeaders(fixture.token, fixture.workspace.slug);
		const newSlug = `seed-fts-test-${crypto.randomUUID().slice(0, 8)}`;

		const created = mcpData<{ id: string; slug: string }>(
			await mcpCall(
				fixture.workspace.id,
				"create_workspace",
				{ slug: newSlug, name: "Seed FTS Test" },
				ownerHeaders
			)
		);
		const newToken = await seedToken(created.id, fixture.user.id);
		const newHeaders = authHeaders(newToken, created.slug);

		const searchRes = await SELF.fetch("http://localhost/api/wiki/search?q=Templates", {
			headers: newHeaders,
		});
		expect(searchRes.status).toBe(200);
		const results = (await searchRes.json()) as Array<{ title: string }>;
		expect(results.map((r) => r.title)).toContain("Templates");
	});
});

// PROJ-493 (R11): watch/unwatch per page or subtree, per-user notifications, and the
// list_wiki_changes delta feed.
describe("Wiki watchers + list_wiki_changes (PROJ-493)", () => {
	let token: string;
	let userId: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		// admin: several tests (cascade delete, delta-delete) delete workspace-level
		// pages, which requireWikiDelete restricts to admin/owner.
		const fixture = await seedFixture({ role: "admin" });
		token = fixture.token;
		userId = fixture.user.id;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	async function req(url: string, opts?: RequestInit) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return SELF.fetch(url, opts);
	}

	async function createPage(pageSlug: string, title: string, content = "") {
		const res = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title, content, slug: pageSlug }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string; slug: string };
	}

	async function createChildPage(
		pageSlug: string,
		title: string,
		content: string,
		parentId: string
	) {
		const res = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title, content, slug: pageSlug, parentId }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string; slug: string };
	}

	async function seedWatcher(role = "member") {
		const user = await seedUser(`watcher-${crypto.randomUUID().slice(0, 8)}@example.com`);
		await seedMember(workspaceId, user.id, role);
		const watcherToken = await seedToken(workspaceId, user.id);
		return { user, token: watcherToken };
	}

	async function notifications(watcherToken: string, query = "") {
		const res = await req(`http://localhost/api/wiki/notifications${query}`, {
			headers: authHeaders(watcherToken, slug),
		});
		expect(res.status).toBe(200);
		return (await res.json()) as Array<{
			id: string;
			pageId: string;
			slug: string;
			title: string;
			action: string;
			actorId: string | null;
		}>;
	}

	it("REST: watch/unwatch a page, watching again upserts the subtree flag instead of duplicating", async () => {
		const page = await createPage("watch-me", "Watch Me", "content");

		const watchRes = await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ subtree: false }),
		});
		expect(watchRes.status).toBe(200);

		let watches = (await (
			await req("http://localhost/api/wiki/watches", { headers: authHeaders(token, slug) })
		).json()) as Array<{ pageId: string; subtree: boolean }>;
		const initial = watches.filter((w) => w.pageId === page.id);
		expect(initial.length).toBe(1);
		expect(initial[0]).toMatchObject({ pageId: page.id, subtree: false });

		// Watching the same page again with a different subtree flag upserts, not duplicates.
		await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ subtree: true }),
		});
		watches = (await (
			await req("http://localhost/api/wiki/watches", { headers: authHeaders(token, slug) })
		).json()) as Array<{ pageId: string; subtree: boolean }>;
		expect(watches.filter((w) => w.pageId === page.id).length).toBe(1);
		expect(watches.find((w) => w.pageId === page.id)?.subtree).toBe(true);

		const unwatchRes = await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(unwatchRes.status).toBe(200);
		watches = (await (
			await req("http://localhost/api/wiki/watches", { headers: authHeaders(token, slug) })
		).json()) as Array<{ pageId: string; subtree: boolean }>;
		expect(watches.some((w) => w.pageId === page.id)).toBe(false);
	});

	it("a direct watcher is notified when someone else edits the page, never for their own edit", async () => {
		const page = await createPage("direct-watch", "Direct Watch", "content");
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({}),
		});

		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ content: "self edit" }),
		});
		expect(await notifications(watcher.token)).toEqual([]);

		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "other edit" }),
		});
		const notifs = await notifications(watcher.token);
		expect(notifs.length).toBe(1);
		expect(notifs[0]).toMatchObject({ action: "updated", pageId: page.id, actorId: userId });
	});

	it("unwatching stops further notifications", async () => {
		const page = await createPage("unwatch-stop", "Unwatch Stop", "content");
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({}),
		});
		await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "DELETE",
			headers: authHeaders(watcher.token, slug),
		});
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "after unwatch" }),
		});
		expect(await notifications(watcher.token)).toEqual([]);
	});

	it("subtree watch covers a page created now under it AND a later edit to that descendant", async () => {
		const parent = await createPage("parent-page", "Parent Page", "content");
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${parent.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ subtree: true }),
		});

		const child = await createChildPage("child-page", "Child Page", "child", parent.id);
		let notifs = await notifications(watcher.token);
		expect(notifs.some((n) => n.action === "created" && n.pageId === child.id)).toBe(true);

		await req(`http://localhost/api/wiki/${child.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "child v2" }),
		});
		notifs = await notifications(watcher.token);
		expect(notifs.filter((n) => n.pageId === child.id).length).toBe(2);
	});

	it("a direct-only (non-subtree) watch on the parent does NOT notify for a descendant's changes", async () => {
		const parent = await createPage("parent-narrow", "Parent Narrow", "content");
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${parent.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ subtree: false }),
		});
		await createChildPage("child-narrow", "Child Narrow", "child", parent.id);
		expect(await notifications(watcher.token)).toEqual([]);
	});

	it("template pages never generate watcher notifications", async () => {
		const page = await createPage(
			"watch-template",
			"Watch Template",
			"---\ntemplate: true\n---\nbody"
		);
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({}),
		});
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "---\ntemplate: true\n---\nedited" }),
		});
		expect(await notifications(watcher.token)).toEqual([]);
	});

	it("a cascade delete generates a single 'deleted' notification for the root page, not one per descendant", async () => {
		const parent = await createPage("cascade-parent", "Cascade Parent", "content");
		await createChildPage("cascade-child", "Cascade Child", "child", parent.id);
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${parent.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ subtree: true }),
		});

		const delRes = await req(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(delRes.status).toBe(200);

		const notifs = await notifications(watcher.token);
		const deleteNotifs = notifs.filter((n) => n.action === "deleted");
		expect(deleteNotifs.length).toBe(1);
		expect(deleteNotifs[0]).toMatchObject({ pageId: parent.id, slug: "cascade-parent" });
	});

	it("a cascade delete notifies someone watching a DESCENDANT directly, and clears their watch row", async () => {
		const parent = await createPage("cascade-root", "Cascade Root", "content");
		const child = await createChildPage("cascade-kid", "Cascade Kid", "child", parent.id);
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${child.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({}),
		});

		const delRes = await req(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(delRes.status).toBe(200);

		const deleteNotifs = (await notifications(watcher.token)).filter((n) => n.action === "deleted");
		expect(deleteNotifs.length).toBe(1);
		expect(deleteNotifs[0]).toMatchObject({ pageId: child.id, slug: "cascade-kid" });

		// PROJ-496: the watch row itself is no longer cleared at delete time (that moved
		// to purge, along with R2/wiki_links/wiki_drafts cleanup) — but the trashed page
		// still drops out of the caller's watch LIST (listWikiWatches filters deleted_at).
		const watchesRes = await req("http://localhost/api/wiki/watches", {
			headers: authHeaders(watcher.token, slug),
		});
		expect(await watchesRes.json()).toEqual([]);
		const stillThere = await env.DB.prepare(
			"SELECT COUNT(*) AS c FROM wiki_watchers WHERE page_id = ?"
		)
			.bind(child.id)
			.first<{ c: number }>();
		expect(stillThere?.c).toBe(1);
	});

	it("a cascade undelete notifies someone watching a DESCENDANT directly (PROJ-496 follow-up: symmetric with cascade delete)", async () => {
		const parent = await createPage("cascade-restore-root", "Cascade Restore Root", "content");
		const child = await createChildPage(
			"cascade-restore-kid",
			"Cascade Restore Kid",
			"child",
			parent.id
		);
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${child.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({}),
		});

		const delRes = await req(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(delRes.status).toBe(200);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${parent.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(200);

		const restoreNotifs = (await notifications(watcher.token)).filter(
			(n) => n.action === "updated"
		);
		expect(restoreNotifs.length).toBe(1);
		expect(restoreNotifs[0]).toMatchObject({ pageId: child.id, slug: "cascade-restore-kid" });
	});

	it("unreadOnly=false / watchedOnly=false are honored as false, not coerced true", async () => {
		const page = await createPage("bool-param", "Bool Param", "content");
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({}),
		});
		const t0 = Math.floor(Date.now() / 1000) - 1;
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		await req("http://localhost/api/wiki/notifications/read", {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ all: true }),
		});

		expect((await notifications(watcher.token, "?unreadOnly=true")).length).toBe(0);
		expect((await notifications(watcher.token, "?unreadOnly=false")).length).toBe(1);

		// The watcher watches nothing but `page`; watchedOnly=false must not narrow.
		await createPage("bool-unwatched", "Bool Unwatched", "other");
		const res = await req(`http://localhost/api/wiki/changes?since=${t0}&watchedOnly=false`, {
			headers: authHeaders(watcher.token, slug),
		});
		const body = (await res.json()) as { changes: Array<{ slug: string | null }> };
		expect(body.changes.map((c) => c.slug)).toContain("bool-unwatched");
	});

	it("mark_wiki_notifications_read: by explicit ids, then all:true", async () => {
		const page = await createPage("read-flag", "Read Flag", "content");
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${page.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({}),
		});
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v3" }),
		});

		const unread = await notifications(watcher.token, "?unreadOnly=true");
		expect(unread.length).toBe(2);

		await req("http://localhost/api/wiki/notifications/read", {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ ids: [unread[0].id] }),
		});
		expect((await notifications(watcher.token, "?unreadOnly=true")).length).toBe(1);

		await req("http://localhost/api/wiki/notifications/read", {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ all: true }),
		});
		expect((await notifications(watcher.token, "?unreadOnly=true")).length).toBe(0);
	});

	it("list_wiki_changes: since is exclusive, nextSince advances, default scope isn't limited to watched pages", async () => {
		const t0 = Math.floor(Date.now() / 1000) - 1;
		const page = await createPage("delta-doc", "Delta Doc", "content");

		const res = await req(`http://localhost/api/wiki/changes?since=${t0}`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			changes: Array<{ action: string; pageId: string }>;
			nextSince: number;
		};
		expect(body.changes.some((c) => c.pageId === page.id && c.action === "created")).toBe(true);
		expect(body.nextSince).toBeGreaterThanOrEqual(t0);

		const empty = (await (
			await req(`http://localhost/api/wiki/changes?since=${body.nextSince}`, {
				headers: authHeaders(token, slug),
			})
		).json()) as { changes: unknown[] };
		expect(empty.changes).toEqual([]);
	});

	it("list_wiki_changes reports a deleted page's slug/title even though the row is gone", async () => {
		const t0 = Math.floor(Date.now() / 1000) - 1;
		const page = await createPage("delta-delete", "Delta Delete", "content");
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});

		const body = (await (
			await req(`http://localhost/api/wiki/changes?since=${t0}`, {
				headers: authHeaders(token, slug),
			})
		).json()) as { changes: Array<{ action: string; slug: string | null; title: string | null }> };
		const deleteEvent = body.changes.find((c) => c.action === "deleted");
		expect(deleteEvent).toMatchObject({ slug: "delta-delete", title: "Delta Delete" });
	});

	// PROJ-526: a cascade delete only records one activity row (for the root), so a
	// poller building a local mirror needs the descendant ids surfaced on that one event
	// to evict them too — otherwise they never get told the descendants also vanished.
	it("list_wiki_changes surfaces deletedPageIds on a cascade delete's root event", async () => {
		const t0 = Math.floor(Date.now() / 1000) - 1;
		const parent = await createPage("delta-cascade-parent", "Delta Cascade Parent", "content");
		const child = await createChildPage(
			"delta-cascade-child",
			"Delta Cascade Child",
			"child",
			parent.id
		);

		const delRes = await req(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(delRes.status).toBe(200);

		const body = (await (
			await req(`http://localhost/api/wiki/changes?since=${t0}`, {
				headers: authHeaders(token, slug),
			})
		).json()) as {
			changes: Array<{ action: string; pageId: string; deletedPageIds: string[] | null }>;
		};
		const deleteEvent = body.changes.find((c) => c.action === "deleted" && c.pageId === parent.id);
		expect(deleteEvent?.deletedPageIds?.sort()).toEqual([child.id, parent.id].sort());

		// Non-cascade events (e.g. the earlier "created" events) carry no deletedPageIds.
		const createdEvent = body.changes.find((c) => c.action === "created" && c.pageId === parent.id);
		expect(createdEvent?.deletedPageIds ?? null).toBeNull();
	});

	it("list_wiki_changes hides changes to a project-scoped page the caller can't see", async () => {
		const project = await seedProject(workspaceId, `PRJ${crypto.randomUUID().slice(0, 4)}`);
		await seedGroupGrant(workspaceId, userId, project.id);
		const t0 = Math.floor(Date.now() / 1000) - 1;

		const created = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Restricted",
				content: "secret",
				projectId: project.id,
				slug: "restricted-delta",
			}),
		});
		expect(created.status).toBe(201);

		// A workspace viewer with no grant on `project` shouldn't see this change.
		const outsider = await seedWatcher("viewer");
		const body = (await (
			await req(`http://localhost/api/wiki/changes?since=${t0}`, {
				headers: authHeaders(outsider.token, slug),
			})
		).json()) as { changes: Array<{ slug: string | null }> };
		expect(body.changes.some((c) => c.slug === "restricted-delta")).toBe(false);

		// The grantee (the creator) does see it.
		const ownBody = (await (
			await req(`http://localhost/api/wiki/changes?since=${t0}`, {
				headers: authHeaders(token, slug),
			})
		).json()) as { changes: Array<{ slug: string | null }> };
		expect(ownBody.changes.some((c) => c.slug === "restricted-delta")).toBe(true);
	});

	it("list_wiki_changes watchedOnly=true narrows to watched pages, including via a subtree watch", async () => {
		const parent = await createPage("watched-scope-parent", "Watched Scope Parent", "content");
		const other = await createPage("unwatched-scope", "Unwatched Scope", "content");
		const watcher = await seedWatcher();
		await req(`http://localhost/api/wiki/${parent.slug}/watch`, {
			method: "POST",
			headers: authHeaders(watcher.token, slug),
			body: JSON.stringify({ subtree: true }),
		});

		const child = await createChildPage(
			"watched-scope-child",
			"Watched Scope Child",
			"child",
			parent.id
		);
		await req(`http://localhost/api/wiki/${other.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});

		const body = (await (
			await req("http://localhost/api/wiki/changes?since=0&watchedOnly=true", {
				headers: authHeaders(watcher.token, slug),
			})
		).json()) as { changes: Array<{ pageId: string }> };
		const pageIds = body.changes.map((c) => c.pageId);
		expect(pageIds).toContain(child.id);
		expect(pageIds).not.toContain(other.id);
	});

	it("MCP: watch_wiki_page / list_wiki_watches / list_wiki_changes mirror the REST behavior", async () => {
		// Several MCP calls back-to-back would otherwise trip the same per-token rate
		// limit that req() clears for REST calls above.
		async function mcp<T>(name: string, args: unknown) {
			await env.DB.prepare("DELETE FROM rate_limit").run();
			return mcpCall<T>(workspaceId, name, args, authHeaders(token, slug));
		}

		// Captured before createPage — since is exclusive and page creation's own
		// activity row must land after this cutoff, not before it (a slow full-suite
		// run can otherwise push several real seconds between here and list_wiki_changes).
		const t0 = Math.floor(Date.now() / 1000) - 1;
		const page = await createPage("mcp-watch", "MCP Watch", "content");

		const watchRes = await mcp("watch_wiki_page", { slug: page.slug });
		expect(isMcpError(watchRes)).toBe(false);

		const watches = mcpData<Array<{ pageId: string }>>(await mcp("list_wiki_watches", {}));
		expect(watches.some((w) => w.pageId === page.id)).toBe(true);

		const unwatchRes = await mcp("unwatch_wiki_page", { slug: page.slug });
		expect(isMcpError(unwatchRes)).toBe(false);
		const watchesAfter = mcpData<Array<{ pageId: string }>>(await mcp("list_wiki_watches", {}));
		expect(watchesAfter.some((w) => w.pageId === page.id)).toBe(false);

		const changes = mcpData<{ changes: Array<{ pageId: string; action: string }> }>(
			await mcp("list_wiki_changes", { since: t0 })
		);
		expect(changes.changes.some((c) => c.pageId === page.id && c.action === "created")).toBe(true);
	});
});

describe("Wiki server-side drafts (PROJ-495)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "admin" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	async function req(url: string, opts?: RequestInit) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return SELF.fetch(url, opts);
	}

	async function createPage(pageSlug: string, title: string, content = "") {
		const res = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title, content, slug: pageSlug }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string; slug: string };
	}

	it("REST: no draft returns null, saving upserts, discarding clears it", async () => {
		const page = await createPage("draft-page", "Draft Page", "original content");

		const empty = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			headers: authHeaders(token, slug),
		});
		expect(empty.status).toBe(200);
		expect(await empty.json()).toBeNull();

		const saveRes = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Draft Page", content: "draft v1", baseRevisionId: null }),
		});
		expect(saveRes.status).toBe(200);

		let getRes = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			headers: authHeaders(token, slug),
		});
		expect(await getRes.json()).toMatchObject({ title: "Draft Page", content: "draft v1" });

		// Saving again upserts in place — no accumulation of draft rows.
		await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Draft Page", content: "draft v2", baseRevisionId: null }),
		});
		getRes = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			headers: authHeaders(token, slug),
		});
		expect(await getRes.json()).toMatchObject({ content: "draft v2" });

		const discardRes = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(discardRes.status).toBe(200);
		getRes = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			headers: authHeaders(token, slug),
		});
		expect(await getRes.json()).toBeNull();
	});

	it("drafts are per-user — one user's draft is invisible to another", async () => {
		const page = await createPage("draft-per-user", "Draft Per User", "content");
		const other = await seedUser(`other-${crypto.randomUUID().slice(0, 8)}@example.com`);
		await seedMember(workspaceId, other.id, "admin");
		const otherToken = await seedToken(workspaceId, other.id);

		await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Draft Per User", content: "mine", baseRevisionId: null }),
		});

		const otherGet = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			headers: authHeaders(otherToken, slug),
		});
		expect(await otherGet.json()).toBeNull();
	});

	it("publishing the draft's content through the normal update path works, and discarding after publish clears it", async () => {
		const page = await createPage("draft-publish", "Draft Publish", "v0");
		const pageRes = await req(`http://localhost/api/wiki/${page.slug}`, {
			headers: authHeaders(token, slug),
		});
		const pageBody = (await pageRes.json()) as { updated_at: number };

		const revRes = await req(`http://localhost/api/wiki/${page.slug}/revisions`, {
			headers: authHeaders(token, slug),
		});
		const revisions = (await revRes.json()) as Array<{ id: string }>;
		const baseRevisionId = revisions[0]?.id ?? null;

		await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Draft Publish", content: "draft content", baseRevisionId }),
		});

		// Publish reuses the EXISTING conflict-checked update path — not a separate
		// draft-publish endpoint — with the draft's own baseRevisionId.
		const publishRes = await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "draft content", baseRevisionId }),
		});
		expect(publishRes.status).toBe(200);
		expect(pageBody.updated_at).toBeDefined();

		const discardRes = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(discardRes.status).toBe(200);
		const getRes = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			headers: authHeaders(token, slug),
		});
		expect(await getRes.json()).toBeNull();
	});

	it("a stale baseRevisionId on publish still hits the normal 409 conflict — no separate draft conflict mechanism", async () => {
		const page = await createPage("draft-conflict", "Draft Conflict", "v0");

		// Establish a first revision, and capture its id the way startEdit() would —
		// this is the baseRevisionId the draft freezes and later resubmits on publish.
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v1" }),
		});
		const revRes = await req(`http://localhost/api/wiki/${page.slug}/revisions`, {
			headers: authHeaders(token, slug),
		});
		const revisions = (await revRes.json()) as Array<{ id: string }>;
		const draftBaseRevisionId = revisions[0]?.id;
		expect(draftBaseRevisionId).toBeTruthy();

		// Save a draft frozen at that revision, exactly as the client's autosave would.
		await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Draft Conflict",
				content: "in-progress draft edit",
				baseRevisionId: draftBaseRevisionId,
			}),
		});

		// Someone else's edit advances the page's latest revision past what the draft
		// was based on.
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "someone else's edit" }),
		});

		// Publish resubmits the DRAFT's own (now-stale) baseRevisionId — exactly what
		// useWikiEditing's save() sends after a restoreDraft() — and must hit the same
		// 409 conflict path as any other stale edit.
		const publishRes = await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "stale draft content", baseRevisionId: draftBaseRevisionId }),
		});
		expect(publishRes.status).toBe(409);
	});

	it("trashing a page (cascade or not) leaves its draft rows in place until purge (PROJ-496)", async () => {
		const parent = await createPage("draft-delete-parent", "Draft Delete Parent", "content");
		const child = (await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Draft Delete Child",
				content: "content",
				slug: "draft-delete-child",
				parentId: parent.id,
			}),
		}).then((r) => r.json())) as { id: string; slug: string };

		await req(`http://localhost/api/wiki/${parent.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				title: "Draft Delete Parent",
				content: "draft",
				baseRevisionId: null,
			}),
		});
		await req(`http://localhost/api/wiki/${child.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Draft Delete Child", content: "draft", baseRevisionId: null }),
		});

		const rows = await env.DB.prepare("SELECT page_id FROM wiki_drafts WHERE workspace_id = ?")
			.bind(workspaceId)
			.all();
		expect(rows.results.length).toBe(2);

		const delRes = await req(`http://localhost/api/wiki/${parent.slug}?cascade=true`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(delRes.status).toBe(200);

		// PROJ-496: draft cleanup moved to purge time — trashing the page (even cascaded)
		// leaves the draft rows untouched.
		const rowsAfterDelete = await env.DB.prepare(
			"SELECT page_id FROM wiki_drafts WHERE workspace_id = ?"
		)
			.bind(workspaceId)
			.all();
		expect(rowsAfterDelete.results.length).toBe(2);

		// Backdate past the 30-day retention window and purge.
		await env.DB.prepare(
			"UPDATE wiki_pages SET deleted_at = ? WHERE workspace_id = ? AND deleted_at IS NOT NULL"
		)
			.bind(Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60, workspaceId)
			.run();
		const purgeRes = await req("http://localhost/api/wiki/purge-trash", {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(purgeRes.status).toBe(200);

		const rowsAfterPurge = await env.DB.prepare(
			"SELECT page_id FROM wiki_drafts WHERE workspace_id = ?"
		)
			.bind(workspaceId)
			.all();
		expect(rowsAfterPurge.results.length).toBe(0);
	});

	it("validation: title and content are required on save", async () => {
		const page = await createPage("draft-validation", "Draft Validation", "content");
		const res = await req(`http://localhost/api/wiki/${page.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("MCP: save_wiki_draft / get_wiki_draft / discard_wiki_draft mirror the REST behavior", async () => {
		async function mcp<T>(name: string, args: unknown) {
			await env.DB.prepare("DELETE FROM rate_limit").run();
			return mcpCall<T>(workspaceId, name, args, authHeaders(token, slug));
		}
		const page = await createPage("mcp-draft", "MCP Draft", "content");

		const saveRes = await mcp("save_wiki_draft", {
			slug: page.slug,
			title: "MCP Draft",
			content: "mcp draft content",
			baseRevisionId: null,
		});
		expect(isMcpError(saveRes)).toBe(false);

		const draft = mcpData<{ content: string } | null>(
			await mcp("get_wiki_draft", { slug: page.slug })
		);
		expect(draft).toMatchObject({ content: "mcp draft content" });

		const discardRes = await mcp("discard_wiki_draft", { slug: page.slug });
		expect(isMcpError(discardRes)).toBe(false);

		const afterDiscard = mcpData<{ content: string } | null>(
			await mcp("get_wiki_draft", { slug: page.slug })
		);
		expect(afterDiscard).toBeNull();
	});
});

describe("Wiki trash (PROJ-496)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		// admin: deleteWikiPage/undeleteWikiPage/purgeExpiredWikiPages on a workspace-level
		// page all require admin/owner (requireWikiDelete / isWorkspaceAdmin).
		const fixture = await seedFixture({ role: "admin" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	async function req(url: string, opts?: RequestInit) {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		return SELF.fetch(url, opts);
	}

	async function createPage(title: string, content: string, opts?: Record<string, unknown>) {
		const res = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title, content, ...opts }),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string; slug: string };
	}

	async function trashPage(pageSlug: string, cascade = false) {
		const res = await req(
			`http://localhost/api/wiki/${pageSlug}${cascade ? "?cascade=true" : ""}`,
			{ method: "DELETE", headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
	}

	function backdateTrash(seconds = 31 * 24 * 60 * 60) {
		return env.DB.prepare(
			"UPDATE wiki_pages SET deleted_at = ? WHERE workspace_id = ? AND deleted_at IS NOT NULL"
		)
			.bind(Math.floor(Date.now() / 1000) - seconds, workspaceId)
			.run();
	}

	it("a trashed page disappears from the list, tree, search, stale-pages, and templates endpoints", async () => {
		const page = await createPage("Trash List Page", "trash-list-searchterm");
		await trashPage(page.slug);

		const listRes = await req("http://localhost/api/wiki", { headers: authHeaders(token, slug) });
		expect(((await listRes.json()) as Array<{ id: string }>).some((p) => p.id === page.id)).toBe(
			false
		);

		const treeRes = await req("http://localhost/api/wiki/tree", {
			headers: authHeaders(token, slug),
		});
		type TreeNode = { id: string; children: TreeNode[] };
		const flatten = (nodes: TreeNode[]): string[] =>
			nodes.flatMap((n) => [n.id, ...flatten(n.children ?? [])]);
		expect(flatten((await treeRes.json()) as TreeNode[])).not.toContain(page.id);

		const searchRes = await req("http://localhost/api/wiki/search?q=trash-list-searchterm", {
			headers: authHeaders(token, slug),
		});
		expect(await searchRes.json()).toEqual([]);

		const templatePage = await createPage(
			"Trash Template Page",
			["---", "template: true", "---", "content"].join("\n")
		);
		await trashPage(templatePage.slug);
		const templatesRes = await req("http://localhost/api/wiki/templates", {
			headers: authHeaders(token, slug),
		});
		expect(
			((await templatesRes.json()) as Array<{ id: string }>).some((p) => p.id === templatePage.id)
		).toBe(false);
	});

	it("GET /api/wiki/:slug and GET /api/wiki/:id both 404 for a trashed page", async () => {
		const page = await createPage("Trash Get Page", "content");
		await trashPage(page.slug);

		const bySlug = await req(`http://localhost/api/wiki/${page.slug}`, {
			headers: authHeaders(token, slug),
		});
		expect(bySlug.status).toBe(404);

		const byId = await req(`http://localhost/api/wiki/${page.id}`, {
			headers: authHeaders(token, slug),
		});
		expect(byId.status).toBe(404);
	});

	it("a trashed source page no longer counts as a backlink", async () => {
		const target = await createPage("Trash Backlink Target", "target content");
		const source = await createPage("Trash Backlink Source", "see [[Trash Backlink Target]]");

		let backlinksRes = await req(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		expect((await backlinksRes.json()) as Array<{ slug: string }>).toEqual([
			expect.objectContaining({ slug: source.slug, title: "Trash Backlink Source" }),
		]);

		await trashPage(source.slug);
		backlinksRes = await req(`http://localhost/api/wiki/${target.slug}/backlinks`, {
			headers: authHeaders(token, slug),
		});
		expect(await backlinksRes.json()).toEqual([]);
	});

	it("a redirect pointing at a trashed page 404s instead of resolving", async () => {
		const page = await createPage("Trash Redirect Target", "content");
		const renameRes = await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "trash-redirect-target-renamed" }),
		});
		expect(renameRes.status).toBe(200);

		// The OLD slug is now just a redirect; it must still resolve to the live page...
		const stillLive = await req(`http://localhost/api/wiki/${page.slug}`, {
			headers: authHeaders(token, slug),
		});
		expect(stillLive.status).toBe(200);

		// ...but once the page (now at the new slug) is trashed, the redirect must 404
		// rather than resolving to a page that no longer exists in any live read path.
		await trashPage("trash-redirect-target-renamed");
		const afterTrash = await req(`http://localhost/api/wiki/${page.slug}`, {
			headers: authHeaders(token, slug),
		});
		expect(afterTrash.status).toBe(404);
	});

	it("cascade trash moves the whole subtree as one unit: same deleted_at, all 404 via the API", async () => {
		const parent = await createPage("Trash Cascade Parent", "content");
		const child = await createPage("Trash Cascade Child", "content", { parentId: parent.id });
		const grandchild = await createPage("Trash Cascade Grandchild", "content", {
			parentId: child.id,
		});

		await trashPage(parent.slug, true);

		const rows = await env.DB.prepare("SELECT id, deleted_at FROM wiki_pages WHERE id IN (?, ?, ?)")
			.bind(parent.id, child.id, grandchild.id)
			.all<{ id: string; deleted_at: number | null }>();
		expect(rows.results.length).toBe(3);
		const deletedAts = new Set(rows.results.map((r) => r.deleted_at));
		expect(deletedAts.size).toBe(1);
		expect(rows.results.every((r) => r.deleted_at !== null)).toBe(true);

		for (const p of [parent, child, grandchild]) {
			const res = await req(`http://localhost/api/wiki/${p.slug}`, {
				headers: authHeaders(token, slug),
			});
			expect(res.status).toBe(404);
		}
	});

	it("GET /api/wiki/trash lists trashed pages with a purgeAfter timestamp, and excludes live pages", async () => {
		const live = await createPage("Trash List Live", "content");
		const trashed = await createPage("Trash List Trashed", "content");
		await trashPage(trashed.slug);

		const res = await req("http://localhost/api/wiki/trash", { headers: authHeaders(token, slug) });
		expect(res.status).toBe(200);
		const rows = (await res.json()) as Array<{
			id: string;
			deleted_at: number;
			purgeAfter: number;
		}>;
		expect(rows.some((r) => r.id === live.id)).toBe(false);
		const row = rows.find((r) => r.id === trashed.id);
		expect(row).toBeDefined();
		expect(row?.purgeAfter).toBe(row!.deleted_at + 30 * 24 * 60 * 60);
	});

	it("POST /api/wiki/trash/:id/undelete restores a trashed page: it becomes visible again", async () => {
		const page = await createPage("Trash Undelete Page", "content");
		await trashPage(page.slug);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${page.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(200);
		expect(await undeleteRes.json()).toMatchObject({ ok: true, id: page.id, slug: page.slug });

		const getRes = await req(`http://localhost/api/wiki/${page.slug}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(200);
	});

	it("undelete rejects a slug that's since been taken by a new live page (409 conflict)", async () => {
		const page = await createPage("Trash Conflict Page", "content");
		await trashPage(page.slug);

		// A brand-new page can now legitimately claim the freed-up slug.
		const reclaimed = await createPage("Trash Conflict Reclaimed", "content", {
			slug: page.slug,
		});
		expect(reclaimed.slug).toBe(page.slug);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${page.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(409);
	});

	it("undelete 404s for an unknown id and 400s for a page that isn't actually trashed", async () => {
		const unknownRes = await req(
			`http://localhost/api/wiki/trash/${crypto.randomUUID()}/undelete`,
			{ method: "POST", headers: authHeaders(token, slug) }
		);
		expect(unknownRes.status).toBe(404);

		const live = await createPage("Trash Not Trashed Page", "content");
		const notTrashedRes = await req(`http://localhost/api/wiki/trash/${live.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(notTrashedRes.status).toBe(400);
	});

	it("POST /api/wiki/purge-trash requires an admin/owner", async () => {
		const memberUser = await seedUser(
			`trash-member-${crypto.randomUUID().slice(0, 8)}@example.com`
		);
		await seedMember(workspaceId, memberUser.id, "member");
		const memberToken = await seedToken(workspaceId, memberUser.id);

		const res = await req("http://localhost/api/wiki/purge-trash", {
			method: "POST",
			headers: authHeaders(memberToken, slug),
		});
		expect(res.status).toBe(403);
	});

	it("purge permanently removes only pages trashed more than 30 days ago, and cleans up every dependent table + R2", async () => {
		const oldPage = await createPage("Trash Purge Old", "purge-old-searchterm");
		await createPage("Trash Purge Old Target", "content");
		await req(`http://localhost/api/wiki/${oldPage.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "see [[Trash Purge Old Target]]" }),
		});
		const oldForm = new FormData();
		oldForm.append("file", new File(["old"], "old.txt", { type: "text/plain" }));
		oldForm.append("entityType", "wiki_page");
		oldForm.append("entityId", oldPage.id);
		const oldUploadRes = await req("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: oldForm,
		});
		const { id: oldAttachmentId } = (await oldUploadRes.json()) as { id: string };
		const oldR2Key = (
			await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?")
				.bind(oldAttachmentId)
				.first<{ r2_key: string }>()
		)?.r2_key;
		await req(`http://localhost/api/wiki/${oldPage.slug}/watch`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({}),
		});
		await req(`http://localhost/api/wiki/${oldPage.slug}/draft`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: oldPage.slug, content: "draft", baseRevisionId: null }),
		});
		await req(`http://localhost/api/wiki/${oldPage.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ slug: "trash-purge-old-renamed" }),
		});

		const recentPage = await createPage("Trash Purge Recent", "content");

		await trashPage("trash-purge-old-renamed");
		await trashPage(recentPage.slug);

		// Only the OLD page's trash timestamp is backdated past the retention window.
		await env.DB.prepare("UPDATE wiki_pages SET deleted_at = ? WHERE id = ?")
			.bind(Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60, oldPage.id)
			.run();

		const purgeRes = await req("http://localhost/api/wiki/purge-trash", {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(purgeRes.status).toBe(200);
		const purged = (await purgeRes.json()) as { purgedCount: number; purgedIds: string[] };
		expect(purged.purgedCount).toBe(1);
		expect(purged.purgedIds).toEqual([oldPage.id]);

		expect(
			await env.DB.prepare("SELECT id FROM wiki_pages WHERE id = ?").bind(oldPage.id).first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(oldAttachmentId).first()
		).toBeNull();
		if (oldR2Key) expect(await env.R2.get(oldR2Key)).toBeNull();
		expect(
			await env.DB.prepare("SELECT page_id FROM wiki_fts WHERE page_id = ?")
				.bind(oldPage.id)
				.first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM wiki_links WHERE source_page_id = ?")
				.bind(oldPage.id)
				.first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT page_id FROM wiki_watchers WHERE page_id = ?")
				.bind(oldPage.id)
				.first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT page_id FROM wiki_drafts WHERE page_id = ?")
				.bind(oldPage.id)
				.first()
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM wiki_redirects WHERE page_id = ?")
				.bind(oldPage.id)
				.first()
		).toBeNull();

		// The recently-trashed page (not yet 30 days old) survives the purge untouched.
		expect(
			await env.DB.prepare("SELECT id FROM wiki_pages WHERE id = ?").bind(recentPage.id).first()
		).not.toBeNull();
	});

	it("MCP list_wiki_trash / undelete_wiki_page / purge_wiki_trash mirror the REST behavior", async () => {
		async function mcp<T>(name: string, args: unknown) {
			await env.DB.prepare("DELETE FROM rate_limit").run();
			return mcpCall<T>(workspaceId, name, args, authHeaders(token, slug));
		}
		const page = await createPage("MCP Trash Page", "content");
		await trashPage(page.slug);

		const trashList = mcpData<Array<{ id: string; purgeAfter: number }>>(
			await mcp("list_wiki_trash", {})
		);
		expect(trashList.some((r) => r.id === page.id)).toBe(true);

		const restored = mcpData<{ ok: boolean; id: string }>(
			await mcp("undelete_wiki_page", { id: page.id })
		);
		expect(restored).toMatchObject({ ok: true, id: page.id });

		await trashPage(page.slug);
		await backdateTrash();
		const purged = mcpData<{ purgedCount: number; purgedIds: string[] }>(
			await mcp("purge_wiki_trash", {})
		);
		expect(purged.purgedIds).toContain(page.id);
	});

	it("a link to a trashed-but-not-purged page is reported as broken (listBrokenWikiLinks)", async () => {
		const target = await createPage("Trash Broken Link Target", "target content");
		const source = await createPage("Trash Broken Link Source", "see [[Trash Broken Link Target]]");

		let brokenRes = await req("http://localhost/api/wiki/broken-links", {
			headers: authHeaders(token, slug),
		});
		expect(
			((await brokenRes.json()) as Array<{ targetTitle: string }>).some(
				(b) => b.targetTitle === "Trash Broken Link Target"
			)
		).toBe(false);

		// The target is trashed but not yet purged — target_page_id is still set (purge
		// is what nulls it out), so without the EXISTS-deleted_at clause this link would
		// stay silently "resolved" until the 30-day purge finally clears it.
		await trashPage(target.slug);

		brokenRes = await req("http://localhost/api/wiki/broken-links", {
			headers: authHeaders(token, slug),
		});
		expect(
			((await brokenRes.json()) as Array<{ targetTitle: string; sourceSlug: string }>).some(
				(b) => b.targetTitle === "Trash Broken Link Target" && b.sourceSlug === source.slug
			)
		).toBe(true);
	});

	it("purge only removes trash in the caller's own workspace", async () => {
		const other = await seedFixture({ role: "admin" });
		const createOtherRes = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ title: "Other Workspace Trash Page", content: "content" }),
		});
		const otherPage = (await createOtherRes.json()) as { id: string; slug: string };
		await req(`http://localhost/api/wiki/${otherPage.slug}`, {
			method: "DELETE",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		await env.DB.prepare("UPDATE wiki_pages SET deleted_at = ? WHERE id = ?")
			.bind(Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60, otherPage.id)
			.run();

		const purgeRes = await req("http://localhost/api/wiki/purge-trash", {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(purgeRes.status).toBe(200);
		const purged = (await purgeRes.json()) as { purgedIds: string[] };
		expect(purged.purgedIds).not.toContain(otherPage.id);
		expect(
			await env.DB.prepare("SELECT id FROM wiki_pages WHERE id = ?").bind(otherPage.id).first()
		).not.toBeNull();
	});

	it("trash list/undelete/purge never reach across workspaces", async () => {
		const other = await seedFixture({ role: "admin" });
		const createOtherRes = await req("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
			body: JSON.stringify({ title: "Cross Workspace Trash Page", content: "content" }),
		});
		const otherPage = (await createOtherRes.json()) as { id: string; slug: string };
		await req(`http://localhost/api/wiki/${otherPage.slug}`, {
			method: "DELETE",
			headers: authHeaders(other.token, other.workspace.slug),
		});

		const listRes = await req("http://localhost/api/wiki/trash", {
			headers: authHeaders(token, slug),
		});
		const listed = (await listRes.json()) as Array<{ id: string }>;
		expect(listed.some((r) => r.id === otherPage.id)).toBe(false);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${otherPage.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(404);
	});

	it("undeleting a cascade-trashed root also restores descendants sharing the same batch", async () => {
		const parent = await createPage("Cascade Undelete Parent", "content");
		const child = await createPage("Cascade Undelete Child", "content", { parentId: parent.id });
		const grandchild = await createPage("Cascade Undelete Grandchild", "content", {
			parentId: child.id,
		});

		await trashPage(parent.slug, true);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${parent.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(200);
		expect(await undeleteRes.json()).toMatchObject({ ok: true, restoredCount: 3 });

		for (const p of [parent, child, grandchild]) {
			const row = await env.DB.prepare("SELECT deleted_at FROM wiki_pages WHERE id = ?")
				.bind(p.id)
				.first<{ deleted_at: number | null }>();
			expect(row?.deleted_at).toBeNull();

			const res = await req(`http://localhost/api/wiki/${p.slug}`, {
				headers: authHeaders(token, slug),
			});
			expect(res.status).toBe(200);
		}
	});

	it("undeleting a cascade-trashed root 409s when a descendant's slug was reclaimed while trashed, instead of a raw 500", async () => {
		const parent = await createPage("Cascade Undelete Conflict Parent", "content");
		const child = await createPage("Cascade Undelete Conflict Child", "content", {
			parentId: parent.id,
		});

		await trashPage(parent.slug, true);

		// A brand-new page claims the now-freed child slug while the subtree is trashed.
		const reclaimed = await createPage("Cascade Undelete Conflict Reclaimed", "content", {
			slug: child.slug,
		});
		expect(reclaimed.slug).toBe(child.slug);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${parent.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(409);
		const body = (await undeleteRes.json()) as { error?: string; message?: string };
		const message = body.error ?? body.message ?? "";
		expect(message).toContain(child.slug);

		// Nothing in the batch should have been restored — the whole check runs before
		// any row is updated.
		const parentRow = await env.DB.prepare("SELECT deleted_at FROM wiki_pages WHERE id = ?")
			.bind(parent.id)
			.first<{ deleted_at: number | null }>();
		expect(parentRow?.deleted_at).not.toBeNull();
	});

	it("undeleting a cascade-trashed root does NOT restore a descendant that was independently trashed in the same batch-collision window", async () => {
		// Regression test for the trash_batch_id disambiguation (PROJ-496 follow-up):
		// trashing the child alone and then cascade-trashing the parent right after, with
		// no artificial time offset, used to be indistinguishable from "trashed in one
		// cascade batch" when both landed on the same deleted_at second. trash_batch_id
		// gives each deleteWikiPage call its own identity regardless of timestamp, so this
		// now correctly leaves the independently-trashed child alone.
		const parent = await createPage("Cascade Undelete Mixed Parent", "content");
		const child = await createPage("Cascade Undelete Mixed Child", "content", {
			parentId: parent.id,
		});
		await trashPage(child.slug);
		await trashPage(parent.slug, true);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${parent.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(200);
		expect(await undeleteRes.json()).toMatchObject({ ok: true, restoredCount: 1 });

		const childRow = await env.DB.prepare("SELECT deleted_at FROM wiki_pages WHERE id = ?")
			.bind(child.id)
			.first<{ deleted_at: number | null }>();
		expect(childRow?.deleted_at).not.toBeNull();
	});

	it("non-cascade trash leaves an already-trashed child's parent_id untouched, and undelete restores it under the original parent", async () => {
		const parent = await createPage("Noncascade Reparent Parent", "content");
		const child = await createPage("Noncascade Reparent Child", "content", {
			parentId: parent.id,
		});
		await trashPage(child.slug);

		await trashPage(parent.slug, false);

		const childRow = await env.DB.prepare("SELECT parent_id FROM wiki_pages WHERE id = ?")
			.bind(child.id)
			.first<{ parent_id: string | null }>();
		expect(childRow?.parent_id).toBe(parent.id);

		const undeleteRes = await req(`http://localhost/api/wiki/trash/${child.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(200);

		const restoredRow = await env.DB.prepare("SELECT parent_id FROM wiki_pages WHERE id = ?")
			.bind(child.id)
			.first<{ parent_id: string | null }>();
		expect(restoredRow?.parent_id).toBe(parent.id);
	});

	it("purge re-parents a live child left pointing at a page that gets purged", async () => {
		const grandparent = await createPage("Purge Reparent Grandparent", "content");
		const parent = await createPage("Purge Reparent Parent", "content", {
			parentId: grandparent.id,
		});
		const child = await createPage("Purge Reparent Child", "content", { parentId: parent.id });

		// Cascade-trash grandparent -> parent -> child as one batch, then undelete just the
		// child on its own — it's now live again with parent_id still pointing at the
		// still-trashed `parent`.
		await trashPage(grandparent.slug, true);
		const undeleteRes = await req(`http://localhost/api/wiki/trash/${child.id}/undelete`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(undeleteRes.status).toBe(200);

		await backdateTrash();

		const purgeRes = await req("http://localhost/api/wiki/purge-trash", {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(purgeRes.status).toBe(200);
		const purged = (await purgeRes.json()) as { purgedIds: string[] };
		expect(purged.purgedIds).toEqual(expect.arrayContaining([grandparent.id, parent.id]));

		const childRow = await env.DB.prepare("SELECT parent_id FROM wiki_pages WHERE id = ?")
			.bind(child.id)
			.first<{ parent_id: string | null }>();
		// parent_id must not dangle — it either got nulled or repointed at a surviving
		// ancestor, never left pointing at grandparent/parent (both now purged).
		expect(childRow?.parent_id === null || childRow?.parent_id === undefined).toBe(true);
	});

	it("purge deletes wiki_revisions rows for purged pages", async () => {
		const page = await createPage("Purge Revisions Page", "v1");
		await req(`http://localhost/api/wiki/${page.slug}`, {
			method: "PUT",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ content: "v2" }),
		});
		const revisionsBefore = await env.DB.prepare("SELECT id FROM wiki_revisions WHERE page_id = ?")
			.bind(page.id)
			.all<{ id: string }>();
		expect(revisionsBefore.results.length).toBeGreaterThan(0);

		await trashPage(page.slug);
		await backdateTrash();

		const purgeRes = await req("http://localhost/api/wiki/purge-trash", {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(purgeRes.status).toBe(200);

		const revisionsAfter = await env.DB.prepare("SELECT id FROM wiki_revisions WHERE page_id = ?")
			.bind(page.id)
			.all<{ id: string }>();
		expect(revisionsAfter.results.length).toBe(0);
	});
});
