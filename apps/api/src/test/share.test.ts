import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, hashToken, seedFixture, seedIssueFixture } from "./helpers";

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Share tokens", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let issueId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, issueId } = await seedIssueFixture({
			issueTitle: "Shareable issue",
		}));
	});

	it("POST /api/issues/:id/share creates a token and returns { token, url }", async () => {
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; url: string };
		expect(typeof body.token).toBe("string");
		expect(body.token).toHaveLength(32);
		expect(body.url).toBe(`/share/${body.token}`);
	});

	it("GET /api/share/:token returns issue data without auth", async () => {
		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const res = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			title: string;
			priority: string;
			customFields: unknown[];
		};
		expect(data.title).toBe("Shareable issue");
		expect(data.priority).toBeDefined();
		expect(Array.isArray(data.customFields)).toBe(true);
	});

	it("GET /api/share/<expired-token> returns 404", async () => {
		const now = Math.floor(Date.now() / 1000);
		const expiredToken = "00000000000000000000000000000001";
		const { env } = await import("cloudflare:test");
		await env.DB.prepare(
			"INSERT INTO share_tokens (id, issue_id, workspace_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
		)
			.bind(await hashToken(expiredToken), issueId, workspaceId, userId, now - 1, now - 86400)
			.run();

		const res = await SELF.fetch(`http://localhost/api/share/${expiredToken}`);
		expect(res.status).toBe(404);
	});

	it("stores the share token hashed, not in plaintext, in D1", async () => {
		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const { env } = await import("cloudflare:test");
		const row = await env.DB.prepare("SELECT id FROM share_tokens WHERE issue_id = ?")
			.bind(issueId)
			.first<{ id: string }>();

		expect(row?.id).not.toBe(shareToken);
		expect(row?.id).toBe(await hashToken(shareToken));
	});

	it("GET /api/share/<unknown-token> returns 404", async () => {
		const res = await SELF.fetch("http://localhost/api/share/ffffffffffffffffffffffffffffffff");
		expect(res.status).toBe(404);
	});

	it("POST /api/issues/:id/share returns 404 for issue in another workspace", async () => {
		const other = await seedFixture();
		const res = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(other.token, other.workspace.slug),
		});
		expect(res.status).toBe(404);
	});

	it("POST /api/issues/:id/share returns 404 for a nonexistent issue ID", async () => {
		const res = await SELF.fetch(
			"http://localhost/api/issues/00000000-0000-0000-0000-000000000000/share",
			{ method: "POST", headers: authHeaders(token, slug) }
		);
		expect(res.status).toBe(404);
	});

	it("GET /api/share/:token returns project_key, project_name, and status_name", async () => {
		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const res = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			project_key: string | null;
			project_name: string | null;
			status_name: string | null;
			expires_at: number;
		};
		expect(data.project_key).toBe("PROJ");
		expect(data.project_name).toBeDefined();
		expect("status_name" in data).toBe(true);
		expect(typeof data.expires_at).toBe("number");
	});

	it("GET /api/share/:token is reusable — multiple requests all return 200", async () => {
		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		for (let i = 0; i < 3; i++) {
			const res = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
			expect(res.status).toBe(200);
		}
	});

	it("PROJ-240: viewer role cannot create a share link", async () => {
		const viewerFixture = await seedIssueFixture({ role: "viewer" });
		const res = await SELF.fetch(`http://localhost/api/issues/${viewerFixture.issueId}/share`, {
			method: "POST",
			headers: authHeaders(viewerFixture.token, viewerFixture.slug),
		});
		expect(res.status).toBe(403);
	});

	it("PROJ-241: excludes internal custom fields and includes non-internal ones from the public share payload", async () => {
		const { env } = await import("cloudflare:test");
		const now = Math.floor(Date.now() / 1000);

		const internalFieldId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO custom_field_definitions (id, workspace_id, project_id, key, label, type, options, created_at, is_internal) VALUES (?, ?, NULL, ?, ?, 'text', NULL, ?, 1)"
		)
			.bind(internalFieldId, workspaceId, "secret_notes", "Secret Notes", now)
			.run();
		await env.DB.prepare(
			"INSERT INTO custom_field_values (issue_id, field_id, value) VALUES (?, ?, ?)"
		)
			.bind(issueId, internalFieldId, "confidential")
			.run();

		const publicFieldId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO custom_field_definitions (id, workspace_id, project_id, key, label, type, options, created_at, is_internal) VALUES (?, ?, NULL, ?, ?, 'text', NULL, ?, 0)"
		)
			.bind(publicFieldId, workspaceId, "public_note", "Public Note", now)
			.run();
		await env.DB.prepare(
			"INSERT INTO custom_field_values (issue_id, field_id, value) VALUES (?, ?, ?)"
		)
			.bind(issueId, publicFieldId, "hello world")
			.run();

		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const res = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			customFields: Array<{ key: string; value: string }>;
		};
		expect(data.customFields.some((f) => f.key === "secret_notes")).toBe(false);
		expect(data.customFields.some((f) => f.key === "public_note")).toBe(true);
	});

	it("PROJ-242: revokes a share token so it no longer resolves", async () => {
		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const revokeRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(revokeRes.status).toBe(200);

		const res = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
		expect(res.status).toBe(404);
	});

	it("PROJ-242: viewer role cannot revoke a share link", async () => {
		const viewerFixture = await seedIssueFixture({ role: "viewer" });
		const { env } = await import("cloudflare:test");
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			"INSERT INTO share_tokens (id, issue_id, workspace_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
		)
			.bind(
				await hashToken("11111111111111111111111111111111"),
				viewerFixture.issueId,
				viewerFixture.workspaceId,
				viewerFixture.userId,
				now + 86400,
				now
			)
			.run();

		const res = await SELF.fetch(`http://localhost/api/issues/${viewerFixture.issueId}/share`, {
			method: "DELETE",
			headers: authHeaders(viewerFixture.token, viewerFixture.slug),
		});
		expect(res.status).toBe(403);
	});
});
