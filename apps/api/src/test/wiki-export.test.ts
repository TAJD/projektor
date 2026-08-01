import { env, SELF } from "cloudflare:test";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedProject, seedProjectFixture } from "./helpers";

// MAX_EXPORT_PAGES in services/wiki-export.ts — kept in sync manually since the
// constant isn't exported; a mismatch would just make this test seed a few more/fewer
// rows than strictly necessary, not silently pass.
const MAX_EXPORT_PAGES = 500;

/**
 * Seeds `count` wiki pages directly via SQL (bypassing the create-page API) so a
 * page-count-cap test stays fast — content bodies are kept empty since the cap must
 * reject the export before any page content is ever fetched.
 */
async function seedManyPages(
	workspaceId: string,
	userId: string,
	count: number,
	projectId: string | null = null
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const statements = Array.from({ length: count }, (_, i) =>
		env.DB.prepare(
			`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content,
			 parent_id, created_by_id, updated_by_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, '', NULL, ?, ?, ?, ?)`
		).bind(
			crypto.randomUUID(),
			workspaceId,
			projectId,
			`bulk-page-${i}`,
			`Bulk Page ${i}`,
			userId,
			userId,
			now,
			now
		)
	);
	await env.DB.batch(statements);
}

async function createPage(
	token: string,
	slug: string,
	body: Record<string, unknown>
): Promise<{ id: string; slug: string }> {
	const res = await SELF.fetch("http://localhost/api/wiki", {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function uploadAttachment(
	token: string,
	slug: string,
	pageId: string,
	filename: string,
	content: string
): Promise<void> {
	const form = new FormData();
	form.append("file", new File([content], filename, { type: "text/plain" }));
	form.append("entityType", "wiki_page");
	form.append("entityId", pageId);
	const res = await SELF.fetch("http://localhost/api/files", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
		body: form,
	});
	expect(res.status).toBe(201);
}

async function exportZip(
	token: string,
	slug: string,
	query: string
): Promise<{ status: number; entries?: Record<string, Uint8Array> }> {
	const res = await SELF.fetch(`http://localhost/api/wiki/export?${query}`, {
		headers: authHeaders(token, slug),
	});
	if (res.status !== 200) return { status: res.status };
	expect(res.headers.get("content-type")).toBe("application/zip");
	const buf = new Uint8Array(await res.arrayBuffer());
	return { status: res.status, entries: unzipSync(buf) };
}

function entryText(entries: Record<string, Uint8Array>, path: string): string {
	return new TextDecoder().decode(entries[path]);
}

describe("Wiki export (PROJ-497)", () => {
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

	it("exports workspace-level pages with frontmatter when scope=space and no projectId", async () => {
		await createPage(token, slug, {
			title: "Runbook One",
			content: "---\ntype: runbook\n---\nBody one",
		});
		await createPage(token, slug, { title: "Note Two", content: "Plain body, no frontmatter" });

		const { status, entries } = await exportZip(token, slug, "scope=space");
		expect(status).toBe(200);
		const names = Object.keys(entries ?? {}).sort();
		expect(names).toEqual(["pages/note-two.md", "pages/runbook-one.md"]);

		expect(entryText(entries!, "pages/runbook-one.md")).toContain("type: runbook");
		expect(entryText(entries!, "pages/runbook-one.md")).toContain("Body one");

		// Page with no frontmatter block gets a minimal one synthesized (title only).
		const noteText = entryText(entries!, "pages/note-two.md");
		expect(noteText).toMatch(/^---\ntitle: Note Two\n---\n/);
		expect(noteText).toContain("Plain body, no frontmatter");
	});

	it("scopes scope=space to a single project, excluding workspace-level pages", async () => {
		const project = await seedProject(workspaceId);
		await createPage(token, slug, { title: "Workspace Page", content: "ws" });
		await createPage(token, slug, {
			title: "Project Page",
			content: "proj",
			projectId: project.id,
		});

		const { entries } = await exportZip(token, slug, `scope=space&projectId=${project.id}`);
		expect(Object.keys(entries ?? {})).toEqual(["pages/project-page.md"]);
	});

	it("exports a subtree: the target page plus all descendants, excluding unrelated pages", async () => {
		const root = await createPage(token, slug, { title: "Root", content: "root body" });
		const child = await createPage(token, slug, {
			title: "Child",
			content: "child body",
			parentId: root.id,
		});
		await createPage(token, slug, {
			title: "Grandchild",
			content: "grandchild body",
			parentId: child.id,
		});
		await createPage(token, slug, { title: "Unrelated", content: "unrelated body" });

		const { entries } = await exportZip(token, slug, `scope=subtree&pageId=${root.slug}`);
		const names = Object.keys(entries ?? {}).sort();
		expect(names).toEqual(["pages/child.md", "pages/grandchild.md", "pages/root.md"]);
	});

	it("includes file attachments under attachments/<page-slug>/", async () => {
		const page = await createPage(token, slug, { title: "With Attachment", content: "see file" });
		await uploadAttachment(token, slug, page.id, "notes.txt", "attachment bytes");

		const { entries } = await exportZip(token, slug, "scope=space");
		expect(Object.keys(entries ?? {}).sort()).toEqual([
			"attachments/with-attachment/notes.txt",
			"pages/with-attachment.md",
		]);
		expect(entryText(entries!, "attachments/with-attachment/notes.txt")).toBe("attachment bytes");
	});

	it("never leaks another workspace's pages into a space export", async () => {
		await createPage(token, slug, { title: "Mine", content: "mine" });

		const other = await seedFixture({ role: "admin" });
		await createPage(other.token, other.workspace.slug, { title: "Theirs", content: "theirs" });

		const { entries } = await exportZip(token, slug, "scope=space");
		expect(Object.keys(entries ?? {})).toEqual(["pages/mine.md"]);
	});

	it("404s a subtree export for a page id/slug from a different workspace", async () => {
		const other = await seedFixture({ role: "admin" });
		const otherPage = await createPage(other.token, other.workspace.slug, {
			title: "Theirs",
			content: "theirs",
		});

		const { status } = await exportZip(token, slug, `scope=subtree&pageId=${otherPage.id}`);
		expect(status).toBe(404);
	});

	it("404s a space export scoped to a project the caller has no grant on", async () => {
		const member = await seedFixture({ role: "member" });
		const project = await seedProject(member.workspace.id); // no group grant for member.user

		const { status } = await exportZip(
			member.token,
			member.workspace.slug,
			`scope=space&projectId=${project.id}`
		);
		expect(status).toBe(404);
	});

	it("allows a project export for a member with a group grant on that project", async () => {
		const fixture = await seedProjectFixture({ role: "member" });
		await createPage(fixture.token, fixture.slug, {
			title: "Granted",
			content: "granted",
			projectId: fixture.projectId,
		});

		const { status, entries } = await exportZip(
			fixture.token,
			fixture.slug,
			`scope=space&projectId=${fixture.projectId}`
		);
		expect(status).toBe(200);
		expect(Object.keys(entries ?? {})).toEqual(["pages/granted.md"]);
	});

	it("400s when scope is missing or invalid", async () => {
		const res = await SELF.fetch("http://localhost/api/wiki/export?scope=bogus", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(400);
	});

	it("keeps colliding attachment filenames distinct in the zip, with correct content each", async () => {
		const page = await createPage(token, slug, { title: "Collide", content: "body" });
		// The second "notes.txt" renames to "1-notes.txt", which must not clobber the
		// real "1-notes.txt" uploaded after it.
		await uploadAttachment(token, slug, page.id, "notes.txt", "first");
		await uploadAttachment(token, slug, page.id, "notes.txt", "second");
		await uploadAttachment(token, slug, page.id, "1-notes.txt", "third");

		const { status, entries } = await exportZip(token, slug, "scope=space");
		expect(status).toBe(200);
		const names = Object.keys(entries ?? {})
			.filter((n) => n.startsWith("attachments/"))
			.sort();
		expect(names).toHaveLength(3);

		const contents = names.map((n) => entryText(entries!, n)).sort();
		expect(contents).toEqual(["first", "second", "third"]);
	});

	it("defensively excludes a descendant whose projectId mismatches the subtree root's", async () => {
		const project = await seedProject(workspaceId);
		const root = await createPage(token, slug, {
			title: "Root",
			content: "root body",
			projectId: project.id,
		});
		const now = Math.floor(Date.now() / 1000);
		const mismatchedId = crypto.randomUUID();
		// Bypasses validateNewPageParent (services/wiki.ts), which normally forbids a
		// child's projectId from diverging from its parent's — writing directly via SQL
		// simulates a regression of that write-time invariant.
		await env.DB.prepare(
			`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content,
			 parent_id, created_by_id, updated_by_id, created_at, updated_at)
			 VALUES (?, ?, NULL, ?, ?, ?, ?, (SELECT created_by_id FROM wiki_pages WHERE id = ?),
				 (SELECT updated_by_id FROM wiki_pages WHERE id = ?), ?, ?)`
		)
			.bind(
				mismatchedId,
				workspaceId,
				"mismatched-child",
				"Mismatched Child",
				"child body",
				root.id,
				root.id,
				root.id,
				now,
				now
			)
			.run();

		const { status, entries } = await exportZip(token, slug, `scope=subtree&pageId=${root.slug}`);
		expect(status).toBe(200);
		const names = Object.keys(entries ?? {});
		expect(names).toEqual(["pages/root.md"]);
	});

	// Follow-up: these two tests only assert the 400 status, not that the cap check ran
	// before content was fetched — a mutation reverting the early-exit ordering would
	// still pass. Properly covering that needs a query-recording proxy on ctx.db.
	it("rejects a space export whose page count exceeds the cap before fetching content", async () => {
		await seedManyPages(workspaceId, userId, MAX_EXPORT_PAGES + 1);

		const { status } = await exportZip(token, slug, "scope=space");
		expect(status).toBe(400);
	});

	it("rejects a subtree export whose descendant count exceeds the cap during the BFS walk", async () => {
		const root = await createPage(token, slug, { title: "Big Root", content: "root" });
		// Every bulk page is parented directly under root, so collectDescendantIds's BFS
		// sees the whole set on its first level and must bail before pagesByIds fetches
		// content for MAX_EXPORT_PAGES+1 rows.
		const now = Math.floor(Date.now() / 1000);
		const statements = Array.from({ length: MAX_EXPORT_PAGES + 1 }, (_, i) =>
			env.DB.prepare(
				`INSERT INTO wiki_pages (id, workspace_id, project_id, slug, title, content,
				 parent_id, created_by_id, updated_by_id, created_at, updated_at)
				 VALUES (?, ?, NULL, ?, ?, '', ?, ?, ?, ?, ?)`
			).bind(
				crypto.randomUUID(),
				workspaceId,
				`bulk-child-${i}`,
				`Bulk Child ${i}`,
				root.id,
				userId,
				userId,
				now,
				now
			)
		);
		await env.DB.batch(statements);

		const { status } = await exportZip(token, slug, `scope=subtree&pageId=${root.slug}`);
		expect(status).toBe(400);
	});
});
