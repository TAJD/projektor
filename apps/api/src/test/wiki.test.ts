import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedGroupGrant,
	seedProject,
	seedWorkspaceRoles,
} from "./helpers";

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

	it("GET /api/wiki/search excerpt is at most 250 chars", async () => {
		const longContent = "x".repeat(1000);
		await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ title: "Long Page", content: longContent }),
		});
		const res = await SELF.fetch("http://localhost/api/wiki/search?q=Long+Page", {
			headers: authHeaders(token, slug),
		});
		const results = (await res.json()) as Array<{ excerpt: string }>;
		expect(results).toHaveLength(1);
		expect(results[0].excerpt.length).toBeLessThanOrEqual(250);
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
