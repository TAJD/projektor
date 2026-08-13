import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	type JsonRpcError,
	type JsonRpcResult,
	seedFixture,
	seedMember,
	seedProject,
	seedToken,
	seedUser,
	seedWorkspaceRoles,
} from "./helpers";

const ENTITY_ID = crypto.randomUUID();

async function mcpCall<T>(
	workspaceId: string,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return res.json();
}

async function mcpToolResult<T>(
	workspaceId: string,
	name: string,
	toolArgs: unknown,
	headers: Record<string, string>
): Promise<T> {
	const res = (await mcpCall<{ content: Array<{ text: string }> }>(
		workspaceId,
		"tools/call",
		{ name, arguments: toolArgs },
		headers
	)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
	return JSON.parse(res.result.content[0].text) as T;
}

function makeUploadRequest(
	token: string,
	slug: string,
	content = "hello world",
	filename = "test.txt"
) {
	const form = new FormData();
	form.append("file", new File([content], filename, { type: "text/plain" }));
	form.append("entityType", "issue");
	form.append("entityId", ENTITY_ID);
	return SELF.fetch("http://localhost/api/files", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Workspace-Slug": slug,
		},
		body: form,
	});
}

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Files API", () => {
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

	it("GET /api/files lists attachments for an entity", async () => {
		// Upload two files for the same entity
		await makeUploadRequest(token, slug, "content a", "a.txt");
		await makeUploadRequest(token, slug, "content b", "b.txt");

		const res = await SELF.fetch(
			`http://localhost/api/files?entityType=issue&entityId=${ENTITY_ID}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		const list = (await res.json()) as Array<{
			id: string;
			filename: string;
			contentType: string;
			size: number;
			createdAt: number;
		}>;
		expect(list).toHaveLength(2);
		expect(list.map((f) => f.filename).sort()).toEqual(["a.txt", "b.txt"]);
		expect(list[0]).toMatchObject({ contentType: "text/plain" });
	});

	it("GET /api/files returns 400 for missing entityId", async () => {
		const res = await SELF.fetch("http://localhost/api/files?entityType=issue", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/files returns empty array when no attachments exist", async () => {
		const res = await SELF.fetch(
			`http://localhost/api/files?entityType=issue&entityId=${crypto.randomUUID()}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("POST /api/files uploads and returns file metadata", async () => {
		const res = await makeUploadRequest(token, slug);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			id: string;
			filename: string;
			contentType: string;
			size: number;
		};
		expect(body.id).toBeTruthy();
		expect(body.filename).toBe("test.txt");
		expect(body.contentType).toBe("text/plain");
		expect(body.size).toBe("hello world".length);
	});

	it("GET /api/files/:id returns the uploaded content", async () => {
		const uploadRes = await makeUploadRequest(token, slug, "round-trip content", "data.txt");
		const { id } = (await uploadRes.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(200);
		// text/plain is not in the inline allowlist — served as octet-stream to prevent XSS
		expect(getRes.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(getRes.headers.get("Content-Disposition")).toContain("attachment");
		expect(getRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
		const text = await getRes.text();
		expect(text).toBe("round-trip content");
	});

	it("GET /api/files/:id serves images inline with their original content type", async () => {
		const form = new FormData();
		// 1x1 transparent GIF
		const gifBytes = new Uint8Array([
			0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff,
			0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
			0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
		]);
		form.append("file", new File([gifBytes], "img.gif", { type: "image/gif" }));
		form.append("entityType", "issue");
		form.append("entityId", ENTITY_ID);
		const uploadRes = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		const { id } = (await uploadRes.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(200);
		expect(getRes.headers.get("Content-Type")).toBe("image/gif");
		expect(getRes.headers.get("Content-Disposition")).toContain("inline");
	});

	it("GET /api/files/:id/metadata returns the attachment metadata", async () => {
		const uploadRes = await makeUploadRequest(token, slug, "meta content", "meta.txt");
		const { id } = (await uploadRes.json()) as { id: string };

		const res = await SELF.fetch(`http://localhost/api/files/${id}/metadata`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; filename: string; contentType: string };
		expect(body.id).toBe(id);
		expect(body.filename).toBe("meta.txt");
		expect(body.contentType).toBe("text/plain");
	});

	it("GET /api/files/:id/metadata returns 404 for an unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/files/${crypto.randomUUID()}/metadata`, {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("DELETE /api/files/:id removes the file", async () => {
		const uploadRes = await makeUploadRequest(token, slug);
		const { id } = (await uploadRes.json()) as { id: string };

		const delRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(delRes.status).toBe(204);

		const getRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
			headers: authHeaders(token, slug),
		});
		expect(getRes.status).toBe(404);
	});

	// PROJ-494: an inline <img> tag rendering an attachment in wiki content can't set a
	// custom X-Workspace-Slug header, so GET falls back to a `?workspace=` query param.
	it("GET /api/files/:id resolves the workspace from a ?workspace= query param when no header is sent", async () => {
		const uploadRes = await makeUploadRequest(token, slug, "query-param content", "q.txt");
		const { id } = (await uploadRes.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/files/${id}?workspace=${slug}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.status).toBe(200);
		expect(await getRes.text()).toBe("query-param content");
	});

	it("GET /api/files/:id via ?workspace= still 404s for a file in a different workspace", async () => {
		const uploadRes = await makeUploadRequest(token, slug, "content", "q2.txt");
		const { id } = (await uploadRes.json()) as { id: string };

		const other = await seedFixture();
		const getRes = await SELF.fetch(
			`http://localhost/api/files/${id}?workspace=${other.workspace.slug}`,
			{
				headers: { Authorization: `Bearer ${other.token}` },
			}
		);
		expect(getRes.status).toBe(404);
	});

	it("POST /api/files does not honor ?workspace= — the header is still required", async () => {
		const form = new FormData();
		form.append("file", new File(["data"], "f.txt", { type: "text/plain" }));
		form.append("entityType", "issue");
		form.append("entityId", ENTITY_ID);
		const res = await SELF.fetch(`http://localhost/api/files?workspace=${slug}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("GET /api/files/:id returns 404 for a different workspace", async () => {
		const uploadRes = await makeUploadRequest(token, slug);
		const { id } = (await uploadRes.json()) as { id: string };

		// Second workspace — different member
		const other = await seedFixture();

		const getRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(getRes.status).toBe(404);
	});

	it("DELETE /api/files/:id returns 404 when accessed from a different workspace", async () => {
		const uploadRes = await makeUploadRequest(token, slug);
		const { id } = (await uploadRes.json()) as { id: string };

		const other = await seedFixture();

		const delRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
			method: "DELETE",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(delRes.status).toBe(404);
	});

	it("POST /api/files rejects unauthenticated requests", async () => {
		const form = new FormData();
		form.append("file", new File(["data"], "f.txt", { type: "text/plain" }));
		form.append("entityType", "issue");
		form.append("entityId", ENTITY_ID);
		const res = await SELF.fetch("http://localhost/api/files", { method: "POST", body: form });
		expect(res.status).toBe(401);
	});

	it("POST /api/files rejects invalid entityType", async () => {
		const form = new FormData();
		form.append("file", new File(["data"], "f.txt", { type: "text/plain" }));
		form.append("entityType", "project");
		form.append("entityId", ENTITY_ID);
		const res = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Workspace-Slug": slug,
			},
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/files rejects disallowed content type (text/html) → 415", async () => {
		const form = new FormData();
		form.append("file", new File(["<html>evil</html>"], "evil.html", { type: "text/html" }));
		// cofferdam-ignore: Refactor.DuplicateBlock: mirrors the empty-content-type case below, distinct types under test
		form.append("entityType", "issue");
		form.append("entityId", ENTITY_ID);
		const res = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		expect(res.status).toBe(415);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("File type not allowed");
	});

	it("POST /api/files rejects empty content type → 415", async () => {
		const form = new FormData();
		form.append("file", new File(["data"], "noext", { type: "" }));
		form.append("entityType", "issue");
		form.append("entityId", ENTITY_ID);
		const res = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		expect(res.status).toBe(415);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("File type not allowed");
	});

	it("POST /api/files rejects a file over 50 MB → 413", async () => {
		const big = new Uint8Array(50 * 1024 * 1024 + 1);
		const form = new FormData();
		form.append("file", new File([big], "big.png", { type: "image/png" }));
		form.append("entityType", "issue");
		form.append("entityId", ENTITY_ID);
		const res = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("File too large (max 50 MB)");
	});

	it("POST /api/files accepts wiki_page entityType", async () => {
		const wikiPageId = crypto.randomUUID();
		const form = new FormData();
		form.append("file", new File(["wiki content"], "wiki.txt", { type: "text/plain" }));
		form.append("entityType", "wiki_page");
		form.append("entityId", wikiPageId);
		const res = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; filename: string };
		expect(body.filename).toBe("wiki.txt");

		// Can list the attachment back
		const listRes = await SELF.fetch(
			`http://localhost/api/files?entityType=wiki_page&entityId=${wikiPageId}`,
			{ headers: authHeaders(token, slug) }
		);
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as Array<{ filename: string }>;
		expect(list).toHaveLength(1);
		expect(list[0].filename).toBe("wiki.txt");
	});

	it("POST /api/files rejects when workspace quota would be exceeded → 413", async () => {
		const QUOTA = 1024 * 1024 * 1024; // 1 GB
		const now = Math.floor(Date.now() / 1000);
		// Insert a fake attachment that consumes all but 1 byte of the quota
		await env.DB.prepare(
			`INSERT INTO attachments (id, workspace_id, r2_key, filename, content_type, size, entity_type,
       entity_id, created_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				crypto.randomUUID(),
				workspaceId,
				"fake/r2key",
				"existing.png",
				"image/png",
				QUOTA - 1,
				"issue",
				ENTITY_ID,
				userId,
				now
			)
			.run();

		// A 2-byte upload pushes total to QUOTA + 1, exceeding the limit
		const form = new FormData();
		form.append("file", new File(["xy"], "tiny.png", { type: "image/png" }));
		form.append("entityType", "issue");
		form.append("entityId", ENTITY_ID);
		const res = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Workspace storage quota exceeded (1024 MB)");
	});

	describe("POST /api/files/links (wiki_ref and url attachment kinds)", () => {
		async function createWikiPage(headers: Record<string, string>) {
			const res = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Linked page", content: "hello" }),
			});
			const body = (await res.json()) as { id: string };
			return body.id;
		}

		it("attaches a wiki page reference and lists it with title/url", async () => {
			const headers = { ...authHeaders(token, slug), "Content-Type": "application/json" };
			const wikiPageId = await createWikiPage(headers);

			const res = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers,
				body: JSON.stringify({
					kind: "wiki_ref",
					entityType: "issue",
					entityId: ENTITY_ID,
					wikiPageId,
				}),
			});
			expect(res.status).toBe(201);

			const listRes = await SELF.fetch(
				`http://localhost/api/files?entityType=issue&entityId=${ENTITY_ID}`,
				{ headers: authHeaders(token, slug) }
			);
			const list = (await listRes.json()) as Array<{
				kind: string;
				wikiPage: { id: string; title: string; url: string } | null;
			}>;
			const entry = list.find((l) => l.kind === "wiki_ref");
			expect(entry?.wikiPage?.title).toBe("Linked page");
			expect(entry?.wikiPage?.id).toBe(wikiPageId);
		});

		it("rejects a wiki_ref for a non-existent wiki page → 404", async () => {
			const res = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "wiki_ref",
					entityType: "issue",
					entityId: ENTITY_ID,
					wikiPageId: crypto.randomUUID(),
				}),
			});
			expect(res.status).toBe(404);
		});

		it("attaches a URL with a label and lists it", async () => {
			const res = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "url",
					entityType: "issue",
					entityId: ENTITY_ID,
					url: "https://example.com/doc",
					label: "Design doc",
				}),
			});
			expect(res.status).toBe(201);

			const listRes = await SELF.fetch(
				`http://localhost/api/files?entityType=issue&entityId=${ENTITY_ID}`,
				{ headers: authHeaders(token, slug) }
			);
			const list = (await listRes.json()) as Array<{
				kind: string;
				filename: string;
				url: string | null;
			}>;
			const entry = list.find((l) => l.kind === "url");
			expect(entry?.filename).toBe("Design doc");
			expect(entry?.url).toBe("https://example.com/doc");
		});

		it("rejects a malformed URL → 400", async () => {
			const res = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "url",
					entityType: "issue",
					entityId: ENTITY_ID,
					url: "not-a-url",
				}),
			});
			expect(res.status).toBe(400);
		});

		it("rejects a non-http(s) URL scheme → 400", async () => {
			const res = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "url",
					entityType: "issue",
					entityId: ENTITY_ID,
					url: "javascript:alert(1)",
				}),
			});
			expect(res.status).toBe(400);
		});

		it("DELETE removes a link attachment without touching R2", async () => {
			const headers = { ...authHeaders(token, slug), "Content-Type": "application/json" };
			const createRes = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers,
				body: JSON.stringify({
					kind: "url",
					entityType: "issue",
					entityId: ENTITY_ID,
					url: "https://example.com",
				}),
			});
			const { id } = (await createRes.json()) as { id: string };

			const delRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
				method: "DELETE",
				headers: authHeaders(token, slug),
			});
			expect(delRes.status).toBe(204);
		});

		it("rejects attaching a project-scoped wiki page the caller cannot see → 404", async () => {
			// The default fixture user is a plain member with no group grant, so a
			// freshly created project-scoped page is invisible to them (PROJ-311
			// default-deny). Bootstrap an admin in the same workspace to create it.
			const adminUser = await seedUser(`admin-${crypto.randomUUID()}@example.com`);
			await seedMember(workspaceId, adminUser.id, "admin");
			const adminToken = await seedToken(workspaceId, adminUser.id);

			const project = await seedProject(workspaceId);
			const pageRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: authHeaders(adminToken, slug),
				body: JSON.stringify({
					title: "Restricted page",
					content: "secret",
					projectId: project.id,
				}),
			});
			const { id: restrictedPageId } = (await pageRes.json()) as { id: string };

			const res = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "wiki_ref",
					entityType: "issue",
					entityId: ENTITY_ID,
					wikiPageId: restrictedPageId,
				}),
			});
			expect(res.status).toBe(404);
		});

		it("does not leak a project-scoped wiki page's title to a caller without project access", async () => {
			const adminUser = await seedUser(`admin-${crypto.randomUUID()}@example.com`);
			await seedMember(workspaceId, adminUser.id, "admin");
			const adminToken = await seedToken(workspaceId, adminUser.id);
			const adminHeaders = { ...authHeaders(adminToken, slug), "Content-Type": "application/json" };

			const project = await seedProject(workspaceId);
			const pageRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					title: "Secret project page",
					content: "secret",
					projectId: project.id,
				}),
			});
			const { id: restrictedPageId } = (await pageRes.json()) as { id: string };

			// Admin attaches it to an entity — the attachment itself is workspace-visible,
			// only the joined wiki page details should be gated.
			const entityId = crypto.randomUUID();
			const linkRes = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					kind: "wiki_ref",
					entityType: "issue",
					entityId,
					wikiPageId: restrictedPageId,
				}),
			});
			expect(linkRes.status).toBe(201);

			const listRes = await SELF.fetch(
				`http://localhost/api/files?entityType=issue&entityId=${entityId}`,
				{ headers: authHeaders(token, slug) }
			);
			const list = (await listRes.json()) as Array<{ kind: string; wikiPage: unknown }>;
			const entry = list.find((l) => l.kind === "wiki_ref");
			expect(entry?.wikiPage).toBeNull();
		});

		it("trashing the linked wiki page leaves the wiki_ref attachment in place until purge (PROJ-496)", async () => {
			// Deleting a workspace-level page requires admin/owner, so create+delete
			// through a dedicated admin rather than the default member fixture.
			const adminUser = await seedUser(`admin-${crypto.randomUUID()}@example.com`);
			await seedMember(workspaceId, adminUser.id, "admin");
			const adminToken = await seedToken(workspaceId, adminUser.id);
			const adminHeaders = { ...authHeaders(adminToken, slug), "Content-Type": "application/json" };

			const pageRes = await SELF.fetch("http://localhost/api/wiki", {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({ title: "Doomed page", content: "will be deleted" }),
			});
			const { id: wikiPageId, slug: wikiPageSlug } = (await pageRes.json()) as {
				id: string;
				slug: string;
			};

			const entityId = crypto.randomUUID();
			const linkRes = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({ kind: "wiki_ref", entityType: "issue", entityId, wikiPageId }),
			});
			expect(linkRes.status).toBe(201);

			const delRes = await SELF.fetch(`http://localhost/api/wiki/${wikiPageSlug}`, {
				method: "DELETE",
				headers: adminHeaders,
			});
			expect(delRes.status).toBe(200);

			// PROJ-496: wiki attachment/wiki_ref cleanup (deleteWikiPageAttachments) moved
			// from delete time to purge time — the pointer attachment must still exist right
			// after the page is trashed.
			const listRes = await SELF.fetch(
				`http://localhost/api/files?entityType=issue&entityId=${entityId}`,
				{ headers: adminHeaders }
			);
			const list = (await listRes.json()) as Array<{ kind: string; id: string; wikiPage: unknown }>;
			const trashedEntry = list.find((l) => l.kind === "wiki_ref");
			expect(trashedEntry).toBeDefined();
			// The page still exists (not yet purged) but is trashed — it must behave like the
			// existing "unavailable ref" case (a non-visible/deleted page), not resolve full
			// title/url details for a page the user can no longer see live.
			expect(trashedEntry?.wikiPage).toBeNull();

			await env.DB.prepare("DELETE FROM rate_limit").run();
			const metadata = await mcpToolResult<{ wikiPage: unknown }>(
				workspaceId,
				"get_attachment",
				{ id: trashedEntry?.id },
				adminHeaders
			);
			expect(metadata.wikiPage).toBeNull();

			await env.DB.prepare("UPDATE wiki_pages SET deleted_at = ? WHERE id = ?")
				.bind(Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60, wikiPageId)
				.run();
			await env.DB.prepare("DELETE FROM rate_limit").run();
			const purgeRes = await SELF.fetch("http://localhost/api/wiki/purge-trash", {
				method: "POST",
				headers: adminHeaders,
			});
			expect(purgeRes.status).toBe(200);

			await env.DB.prepare("DELETE FROM rate_limit").run();
			const listAfterPurge = await SELF.fetch(
				`http://localhost/api/files?entityType=issue&entityId=${entityId}`,
				{ headers: adminHeaders }
			);
			const listAfter = (await listAfterPurge.json()) as Array<{ kind: string }>;
			expect(listAfter.find((l) => l.kind === "wiki_ref")).toBeUndefined();
		});
	});

	describe("PROJ-425: viewer role is denied write access", () => {
		it("POST /api/files rejects a viewer upload → 403", async () => {
			const { workspace, viewer } = await seedWorkspaceRoles();
			const form = new FormData();
			form.append("file", new File(["data"], "f.txt", { type: "text/plain" }));
			form.append("entityType", "issue");
			form.append("entityId", crypto.randomUUID());
			const res = await SELF.fetch("http://localhost/api/files", {
				method: "POST",
				headers: { Authorization: `Bearer ${viewer.token}`, "X-Workspace-Slug": workspace.slug },
				body: form,
			});
			expect(res.status).toBe(403);
		});

		it("POST /api/files/links rejects a viewer → 403", async () => {
			const { workspace, viewer } = await seedWorkspaceRoles();
			const res = await SELF.fetch("http://localhost/api/files/links", {
				method: "POST",
				headers: {
					...authHeaders(viewer.token, workspace.slug),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					kind: "url",
					entityType: "issue",
					entityId: crypto.randomUUID(),
					url: "https://example.com",
				}),
			});
			expect(res.status).toBe(403);
		});

		it("DELETE /api/files/:id rejects a viewer → 403", async () => {
			const { workspace, owner, viewer } = await seedWorkspaceRoles();
			const form = new FormData();
			form.append("file", new File(["data"], "f.txt", { type: "text/plain" }));
			form.append("entityType", "issue");
			form.append("entityId", crypto.randomUUID());
			const uploadRes = await SELF.fetch("http://localhost/api/files", {
				method: "POST",
				headers: { Authorization: `Bearer ${owner.token}`, "X-Workspace-Slug": workspace.slug },
				body: form,
			});
			const { id } = (await uploadRes.json()) as { id: string };

			const delRes = await SELF.fetch(`http://localhost/api/files/${id}`, {
				method: "DELETE",
				headers: authHeaders(viewer.token, workspace.slug),
			});
			expect(delRes.status).toBe(403);
		});
	});
});

// PROJ-234: attachments previously had no MCP surface at all. list/get/create-link/delete
// are metadata-only (no binary), so they get full MCP parity; upload/download remain
// REST-only (AGENTS.md exception).
describe("Files MCP tools", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	it("create_link_attachment + list_attachments + get_attachment + delete_attachment round-trip", async () => {
		const headers = authHeaders(token, slug);
		const entityId = crypto.randomUUID();

		const created = await mcpToolResult<{ id: string; kind: string }>(
			workspaceId,
			"create_link_attachment",
			{ kind: "url", entityType: "issue", entityId, url: "https://example.com", label: "Docs" },
			headers
		);
		expect(created.kind).toBe("url");

		const list = await mcpToolResult<Array<{ id: string; filename: string; url: string | null }>>(
			workspaceId,
			"list_attachments",
			{ entityType: "issue", entityId },
			headers
		);
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(created.id);
		expect(list[0].url).toBe("https://example.com");

		const meta = await mcpToolResult<{ id: string; filename: string }>(
			workspaceId,
			"get_attachment",
			{ id: created.id },
			headers
		);
		expect(meta.filename).toBe("Docs");

		await mcpToolResult<{ ok: true }>(
			workspaceId,
			"delete_attachment",
			{ id: created.id },
			headers
		);

		const afterDelete = await mcpToolResult<unknown[]>(
			workspaceId,
			"list_attachments",
			{ entityType: "issue", entityId },
			headers
		);
		expect(afterDelete).toHaveLength(0);
	});

	it("get_attachment returns a JSON-RPC error for an unknown id", async () => {
		const res = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "get_attachment", arguments: { id: crypto.randomUUID() } },
			authHeaders(token, slug)
		)) as JsonRpcError;
		expect(res.error).toBeDefined();
		expect(res.error.code).toBe(-32000);
	});

	it("create_link_attachment rejects a wiki_ref for a non-existent page", async () => {
		const res = (await mcpCall(
			workspaceId,
			"tools/call",
			{
				name: "create_link_attachment",
				arguments: {
					kind: "wiki_ref",
					entityType: "issue",
					entityId: crypto.randomUUID(),
					wikiPageId: crypto.randomUUID(),
				},
			},
			authHeaders(token, slug)
		)) as JsonRpcError;
		expect(res.error).toBeDefined();
		expect(res.error.code).toBe(-32000);
	});

	it("delete_attachment via MCP also removes the underlying R2 object for uploaded files", async () => {
		const form = new FormData();
		form.append("file", new File(["mcp delete test"], "mcp.txt", { type: "text/plain" }));
		form.append("entityType", "issue");
		form.append("entityId", crypto.randomUUID());
		const uploadRes = await SELF.fetch("http://localhost/api/files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": slug },
			body: form,
		});
		const { id } = (await uploadRes.json()) as { id: string };

		const row = await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?")
			.bind(id)
			.first<{ r2_key: string }>();
		expect(await env.R2.get(row?.r2_key ?? "")).not.toBeNull();

		await mcpToolResult<{ ok: true }>(
			workspaceId,
			"delete_attachment",
			{ id },
			authHeaders(token, slug)
		);

		expect(await env.R2.get(row?.r2_key ?? "")).toBeNull();
	});

	it("list_attachments scopes by workspace — another workspace sees no rows for the same entityId", async () => {
		const other = await seedFixture();
		const result = await mcpToolResult<unknown[]>(
			other.workspace.id,
			"list_attachments",
			{ entityType: "issue", entityId: ENTITY_ID },
			authHeaders(other.token, other.workspace.slug)
		);
		expect(result).toEqual([]);
	});

	it("create_link_attachment via MCP rejects a viewer session → JSON-RPC error", async () => {
		const { workspace, viewer } = await seedWorkspaceRoles();
		const res = (await mcpCall(
			workspace.id,
			"tools/call",
			{
				name: "create_link_attachment",
				arguments: {
					kind: "url",
					entityType: "issue",
					entityId: crypto.randomUUID(),
					url: "https://example.com",
				},
			},
			authHeaders(viewer.token, workspace.slug)
		)) as JsonRpcError;
		expect(res.error).toBeDefined();
	});

	it("delete_attachment via MCP rejects a viewer session → JSON-RPC error", async () => {
		const { workspace, owner, viewer } = await seedWorkspaceRoles();
		const created = await mcpToolResult<{ id: string }>(
			workspace.id,
			"create_link_attachment",
			{
				kind: "url",
				entityType: "issue",
				entityId: crypto.randomUUID(),
				url: "https://example.com",
			},
			authHeaders(owner.token, workspace.slug)
		);

		const res = (await mcpCall(
			workspace.id,
			"tools/call",
			{ name: "delete_attachment", arguments: { id: created.id } },
			authHeaders(viewer.token, workspace.slug)
		)) as JsonRpcError;
		expect(res.error).toBeDefined();
	});
});
