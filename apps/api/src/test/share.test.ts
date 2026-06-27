import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedIssue, seedProject } from "./helpers";

describe("Share tokens", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let issueId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
		const project = await seedProject(workspaceId);
		const issue = await seedIssue(workspaceId, project.id, userId, { title: "Shareable issue" });
		issueId = issue.id;
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
			.bind(expiredToken, issueId, workspaceId, userId, now - 1, now - 86400)
			.run();

		const res = await SELF.fetch(`http://localhost/api/share/${expiredToken}`);
		expect(res.status).toBe(404);
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
});
