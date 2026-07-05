import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedFixture } from "./helpers";

const ENTITY_ID = crypto.randomUUID();

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
});
