import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedProject, seedProjectFixture, seedWorkspaceRoles } from "./helpers";

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
