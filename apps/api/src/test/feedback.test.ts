import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashFeedbackToken } from "../services/feedback";
import {
	authHeaders,
	seedGroupGrant,
	seedProject,
	seedProjectFixture,
	seedWorkspaceRoles,
} from "./helpers";

describe("feedback migration", () => {
	it("creates feedback_sources and feedback tables", async () => {
		const src = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_sources'"
		).first<{ name: string }>();
		expect(src?.name).toBe("feedback_sources");

		const fb = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'"
		).first<{ name: string }>();
		expect(fb?.name).toBe("feedback");
	});
});

describe("Feedback sources REST", () => {
	it("creates a source (owner) and returns a one-time token", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ name: "Onboarding survey", allowedOrigins: ["https://acme.test"] }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; token: string };
		expect(body.id).toBeTruthy();
		expect(body.token).toBeTruthy();
	});

	it("rejects source creation by a member (403)", async () => {
		const f = await seedProjectFixture({ role: "member" });
		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ name: "X" }),
		});
		expect(res.status).toBe(403);
	});

	it("lists sources with a truncated token preview, never the raw token", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const created = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback-sources`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ name: "NPS" }),
			}
		);
		const { token } = (await created.json()) as { token: string };

		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(200);
		const list = (await res.json()) as Array<{
			name: string;
			tokenPreview: string;
			isActive: boolean;
		}>;
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("NPS");
		expect(list[0].isActive).toBe(true);
		expect(list[0].tokenPreview.length).toBeLessThan(token.length);
		expect(JSON.stringify(list)).not.toContain(token);
	});

	it("updates name/description/isActive (owner)", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const created = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback-sources`,
			{
				method: "POST",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ name: "Old" }),
			}
		);
		const { id } = (await created.json()) as { id: string };

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback-sources/${id}`,
			{
				method: "PATCH",
				headers: authHeaders(f.token, f.slug),
				body: JSON.stringify({ name: "New", isActive: false }),
			}
		);
		expect(res.status).toBe(200);
		const row = await env.DB.prepare("SELECT name, is_active FROM feedback_sources WHERE id = ?")
			.bind(id)
			.first<{ name: string; is_active: number }>();
		expect(row?.name).toBe("New");
		expect(row?.is_active).toBe(0);
	});

	it("revoke stamps revoked_at (owner); member is 403", async () => {
		const roles = await seedWorkspaceRoles();
		const proj = await seedProject(roles.workspace.id, "FBK");
		const create = await SELF.fetch(`http://localhost/api/projects/${proj.id}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ name: "S" }),
		});
		const { id } = (await create.json()) as { id: string };

		const memberRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback-sources/${id}`,
			{ method: "DELETE", headers: authHeaders(roles.member.token, roles.workspace.slug) }
		);
		expect(memberRes.status).toBe(403);

		const ownerRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback-sources/${id}`,
			{ method: "DELETE", headers: authHeaders(roles.owner.token, roles.workspace.slug) }
		);
		expect(ownerRes.status).toBe(200);
		const row = await env.DB.prepare("SELECT revoked_at FROM feedback_sources WHERE id = ?")
			.bind(id)
			.first<{ revoked_at: number | null }>();
		expect(row?.revoked_at).not.toBeNull();
	});
});

async function mintSource(
	f: { projectId: string; token: string; slug: string },
	body: Record<string, unknown> = { name: "Widget" }
): Promise<string> {
	const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
		method: "POST",
		headers: authHeaders(f.token, f.slug),
		body: JSON.stringify(body),
	});
	return ((await res.json()) as { token: string }).token;
}

describe("Feedback submit (public)", () => {
	it("accepts a body-only submission and returns { id } only", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Love it" }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(data)).toEqual(["id"]);

		const row = await env.DB.prepare(
			"SELECT project_id, workspace_id, source_id, status FROM feedback WHERE id = ?"
		)
			.bind(data.id)
			.first<{ project_id: string; workspace_id: string; source_id: string; status: string }>();
		expect(row?.project_id).toBe(f.projectId);
		expect(row?.status).toBe("new");
	});

	it("resolves project/workspace from the source, ignoring body-supplied ids", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x", projectId: "00000000-0000-0000-0000-000000000000" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		const row = await env.DB.prepare("SELECT project_id FROM feedback WHERE id = ?")
			.bind(id)
			.first<{ project_id: string }>();
		expect(row?.project_id).toBe(f.projectId);
	});

	it("rejects an unknown token with 401", async () => {
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects a revoked source with 401", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const list = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			headers: authHeaders(f.token, f.slug),
		});
		const [{ id }] = (await list.json()) as Array<{ id: string }>;
		await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources/${id}`, {
			method: "DELETE",
			headers: authHeaders(f.token, f.slug),
		});
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects an inactive source with 403", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const list = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
			headers: authHeaders(f.token, f.slug),
		});
		const [{ id }] = (await list.json()) as Array<{ id: string }>;
		await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources/${id}`, {
			method: "PATCH",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ isActive: false }),
		});
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(403);
	});

	it("400s an empty submission (neither rating nor body)", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("sets Access-Control-Allow-Origin only for a listed origin", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f, { name: "W", allowedOrigins: ["https://acme.test"] });

		const allowed = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Origin: "https://acme.test",
			},
			body: JSON.stringify({ body: "x" }),
		});
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.test");

		const other = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Origin: "https://evil.test",
			},
			body: JSON.stringify({ body: "x" }),
		});
		expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("answers OPTIONS preflight with 204 and permissive CORS headers", async () => {
		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "OPTIONS",
			headers: { Origin: "https://acme.test", "Access-Control-Request-Method": "POST" },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.test");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
	});

	it("429s once the per-token limit (RATE_LIMIT_FEEDBACK_MAX) is exceeded", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const tokenHash = await hashFeedbackToken(token);
		const slot = Math.floor(Date.now() / 1000 / 60) * 60; // RATE_LIMIT_WINDOW_SECS=60
		// RATE_LIMIT_FEEDBACK_MAX=5 in wrangler.test.toml — seed straight to the limit.
		await env.DB.prepare(
			"INSERT OR REPLACE INTO rate_limit (key, count, window_start) VALUES (?, 5, ?)"
		)
			.bind(`feedback:${tokenHash}`, slot)
			.run();

		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(429);
	});

	it("429s once the per-IP limit (RATE_LIMIT_FEEDBACK_IP_MAX) is exceeded", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const token = await mintSource(f);
		const slot = Math.floor(Date.now() / 1000 / 60) * 60; // RATE_LIMIT_WINDOW_SECS=60
		// RATE_LIMIT_FEEDBACK_IP_MAX=5 in wrangler.test.toml — no CF-Connecting-IP
		// header in tests, so the middleware falls back to the fixed '127.0.0.1' key.
		await env.DB.prepare(
			"INSERT OR REPLACE INTO rate_limit (key, count, window_start) VALUES (?, 5, ?)"
		)
			.bind("feedback-ip:127.0.0.1", slot)
			.run();

		const res = await SELF.fetch("http://localhost/api/feedback/submit", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x" }),
		});
		expect(res.status).toBe(429);
	});
});

async function seedFeedbackRow(
	sourceId: string,
	workspaceId: string,
	projectId: string,
	opts: { body?: string; status?: string } = {}
): Promise<string> {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO feedback (id, source_id, workspace_id, project_id, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(id, sourceId, workspaceId, projectId, opts.body ?? "seed", opts.status ?? "new", now)
		.run();
	return id;
}

describe("Feedback triage read/patch", () => {
	it("GET lists feedback with the source name, filtered by status", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f, { name: "Onboarding" });
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(f.projectId)
			.first<{ id: string }>();
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, { status: "new", body: "a" });
		await seedFeedbackRow(src!.id, f.workspaceId, f.projectId, { status: "reviewed", body: "b" });

		const all = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback`, {
			headers: authHeaders(f.token, f.slug),
		});
		const allRows = (await all.json()) as Array<{ sourceName: string; status: string }>;
		expect(allRows).toHaveLength(2);
		expect(allRows[0].sourceName).toBe("Onboarding");

		const filtered = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback?status=new`,
			{ headers: authHeaders(f.token, f.slug) }
		);
		const rows = (await filtered.json()) as Array<{ status: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("new");
	});

	it("GET 404s for a caller with no project access", async () => {
		const owner = await seedProjectFixture({ role: "owner" });
		await mintSource(owner);
		const stranger = await seedProjectFixture({ role: "owner" }); // different workspace
		const res = await SELF.fetch(`http://localhost/api/projects/${owner.projectId}/feedback`, {
			headers: authHeaders(stranger.token, stranger.slug),
		});
		expect(res.status).toBe(404);
	});

	it("PATCH updates status for member+, 403 for viewer", async () => {
		const roles = await seedWorkspaceRoles();
		const proj = await seedProject(roles.workspace.id, "TRI");
		await seedGroupGrant(roles.workspace.id, roles.member.user.id, proj.id, "member");
		await seedGroupGrant(roles.workspace.id, roles.viewer.user.id, proj.id, "viewer");
		const create = await SELF.fetch(`http://localhost/api/projects/${proj.id}/feedback-sources`, {
			method: "POST",
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
			body: JSON.stringify({ name: "S" }),
		});
		await create.json();
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(proj.id)
			.first<{ id: string }>();
		const fbId = await seedFeedbackRow(src!.id, roles.workspace.id, proj.id);

		const viewerRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback/${fbId}`,
			{
				method: "PATCH",
				headers: authHeaders(roles.viewer.token, roles.workspace.slug),
				body: JSON.stringify({ status: "reviewed" }),
			}
		);
		expect(viewerRes.status).toBe(403);

		const memberRes = await SELF.fetch(
			`http://localhost/api/projects/${proj.id}/feedback/${fbId}`,
			{
				method: "PATCH",
				headers: authHeaders(roles.member.token, roles.workspace.slug),
				body: JSON.stringify({ status: "reviewed" }),
			}
		);
		expect(memberRes.status).toBe(200);
		const row = await env.DB.prepare("SELECT status FROM feedback WHERE id = ?")
			.bind(fbId)
			.first<{ status: string }>();
		expect(row?.status).toBe("reviewed");
	});

	it("GET is readable by a viewer (read visibility, not a write action)", async () => {
		const f = await seedProjectFixture({ role: "viewer" });
		await mintSource(f);
		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(200);
	});

	it("filters by sourceId", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f, { name: "A" });
		await mintSource(f, { name: "B" });
		const sources = await env.DB.prepare(
			"SELECT id, name FROM feedback_sources WHERE project_id = ? ORDER BY name"
		)
			.bind(f.projectId)
			.all<{ id: string; name: string }>();
		const [srcA, srcB] = sources.results!;
		await seedFeedbackRow(srcA.id, f.workspaceId, f.projectId, { body: "from a" });
		await seedFeedbackRow(srcB.id, f.workspaceId, f.projectId, { body: "from b" });

		const res = await SELF.fetch(
			`http://localhost/api/projects/${f.projectId}/feedback?sourceId=${srcA.id}`,
			{ headers: authHeaders(f.token, f.slug) }
		);
		const rows = (await res.json()) as Array<{ sourceId: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].sourceId).toBe(srcA.id);
	});

	it("PATCH rejects an invalid status value", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		await mintSource(f);
		const src = await env.DB.prepare("SELECT id FROM feedback_sources WHERE project_id = ?")
			.bind(f.projectId)
			.first<{ id: string }>();
		const fbId = await seedFeedbackRow(src!.id, f.workspaceId, f.projectId);

		const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback/${fbId}`, {
			method: "PATCH",
			headers: authHeaders(f.token, f.slug),
			body: JSON.stringify({ status: "bogus" }),
		});
		expect(res.status).toBe(400);
	});
});
