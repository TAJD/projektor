import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	hashToken,
	seedFixture,
	seedGroupGrant,
	seedIssue,
	seedIssueFixture,
	seedProject,
} from "./helpers";
import { resetRateLimits } from "./rate-limit-reset";

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

	it("PROJ-241: public share payload excludes internal custom fields, includes non-internal ones", async () => {
		const { env } = await import("cloudflare:test");
		const now = Math.floor(Date.now() / 1000);

		const internalFieldId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO custom_field_definitions (id, workspace_id, project_id, key, label, type, " +
				"options, created_at, is_internal) VALUES (?, ?, NULL, ?, ?, 'text', NULL, ?, 1)"
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
			"INSERT INTO custom_field_definitions (id, workspace_id, project_id, key, label, type, " +
				"options, created_at, is_internal) VALUES (?, ?, NULL, ?, ?, 'text', NULL, ?, 0)"
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

	it("PROJ-762: GET /api/share/:token includes the owning workspace's brand", async () => {
		const owner = await seedIssueFixture({ role: "owner" });
		const patchRes = await SELF.fetch(`http://localhost/api/workspaces/${owner.slug}/brand`, {
			method: "PATCH",
			headers: authHeaders(owner.token, owner.slug),
			body: JSON.stringify({ displayName: "Acme Tracker", accent: "#ff8800" }),
		});
		expect(patchRes.status).toBe(200);

		const createRes = await SELF.fetch(`http://localhost/api/issues/${owner.issueId}/share`, {
			method: "POST",
			headers: authHeaders(owner.token, owner.slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const res = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			brand: { displayName: string | null; accent: string | null; logoUrl: string | null };
		};
		expect(data.brand.displayName).toBe("Acme Tracker");
		expect(data.brand.accent).toBe("#ff8800");
		expect(data.brand.logoUrl).toBeNull();
	});

	it("PROJ-762: GET /api/share/:token returns a null-fielded brand when the workspace has none set", async () => {
		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const res = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			brand: { displayName: string | null; accent: string | null };
		};
		expect(data.brand.displayName).toBeNull();
		expect(data.brand.accent).toBeNull();
	});

	it("review finding 1: GET /api/share/:token/logo serves the workspace logo with no auth", async () => {
		const owner = await seedIssueFixture({ role: "owner" });
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const form = new FormData();
		form.append("file", new File([pngBytes], "logo.png", { type: "image/png" }));
		const ownerAuth = authHeaders(owner.token, owner.slug);
		const uploadRes = await SELF.fetch(`http://localhost/api/workspaces/${owner.slug}/brand/logo`, {
			method: "POST",
			headers: { Authorization: ownerAuth.Authorization, "X-Workspace-Slug": owner.slug },
			body: form,
		});
		expect(uploadRes.status).toBe(201);

		const createRes = await SELF.fetch(`http://localhost/api/issues/${owner.issueId}/share`, {
			method: "POST",
			headers: authHeaders(owner.token, owner.slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const shareRes = await SELF.fetch(`http://localhost/api/share/${shareToken}`);
		const shareData = (await shareRes.json()) as { brand: { logoUrl: string | null } };
		expect(shareData.brand.logoUrl).toBe(`/api/share/${shareToken}/logo`);

		const logoRes = await SELF.fetch(`http://localhost${shareData.brand.logoUrl}`);
		expect(logoRes.status).toBe(200);
		expect(logoRes.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await logoRes.arrayBuffer())).toEqual(pngBytes);
	});

	it("review finding 1: GET /api/share/:token/logo 404s when the workspace has no logo set", async () => {
		const createRes = await SELF.fetch(`http://localhost/api/issues/${issueId}/share`, {
			method: "POST",
			headers: authHeaders(token, slug),
		});
		const { token: shareToken } = (await createRes.json()) as { token: string; url: string };

		const res = await SELF.fetch(`http://localhost/api/share/${shareToken}/logo`);
		expect(res.status).toBe(404);
	});

	it("review finding 1: GET /api/share/<unknown-token>/logo 404s", async () => {
		const res = await SELF.fetch(
			"http://localhost/api/share/ffffffffffffffffffffffffffffffff/logo"
		);
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

	describe("PROJ-792: share create/revoke honour project-level access", () => {
		async function restrictedIssue(grant: "none" | "viewer" | "member", workspaceRole = "member") {
			const { workspace, user, token } = await seedFixture({ role: workspaceRole });
			const project = await seedProject(workspace.id);
			if (grant !== "none") await seedGroupGrant(workspace.id, user.id, project.id, grant);
			const issue = await seedIssue(workspace.id, project.id, user.id, { title: "Restricted" });
			return {
				token,
				slug: workspace.slug,
				workspaceId: workspace.id,
				userId: user.id,
				issueId: issue.id,
			};
		}

		it("member without a grant cannot create a share link (404, existence hidden)", async () => {
			const f = await restrictedIssue("none");
			const res = await SELF.fetch(`http://localhost/api/issues/${f.issueId}/share`, {
				method: "POST",
				headers: authHeaders(f.token, f.slug),
			});
			expect(res.status).toBe(404);
			const { env } = await import("cloudflare:test");
			const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM share_tokens WHERE issue_id = ?")
				.bind(f.issueId)
				.first<{ n: number }>();
			expect(row?.n).toBe(0);
		});

		it("member without a grant cannot revoke someone else's share link", async () => {
			const f = await restrictedIssue("none");
			const { env } = await import("cloudflare:test");
			const now = Math.floor(Date.now() / 1000);
			await env.DB.prepare(
				"INSERT INTO share_tokens (id, issue_id, workspace_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
			)
				.bind(await hashToken("victim-link"), f.issueId, f.workspaceId, f.userId, now + 3600, now)
				.run();
			const res = await SELF.fetch(`http://localhost/api/issues/${f.issueId}/share`, {
				method: "DELETE",
				headers: authHeaders(f.token, f.slug),
			});
			expect(res.status).toBe(404);
			const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM share_tokens WHERE issue_id = ?")
				.bind(f.issueId)
				.first<{ n: number }>();
			expect(row?.n).toBe(1);
		});

		it("member with only a viewer grant gets 403", async () => {
			const f = await restrictedIssue("viewer");
			const res = await SELF.fetch(`http://localhost/api/issues/${f.issueId}/share`, {
				method: "POST",
				headers: authHeaders(f.token, f.slug),
			});
			expect(res.status).toBe(403);
		});

		it("workspace viewer with a member grant on the project can share (grant replaces workspace role)", async () => {
			const f = await restrictedIssue("member", "viewer");
			const res = await SELF.fetch(`http://localhost/api/issues/${f.issueId}/share`, {
				method: "POST",
				headers: authHeaders(f.token, f.slug),
			});
			expect(res.status).toBe(201);
		});
	});

	// PROJ-794: a share link dies with its issue, its project's archival, or its
	// creator's access — checked every time the link is read.
	describe("PROJ-794: share links stop resolving when the issue or the creator's access goes", () => {
		async function sharedIssue(workspaceRole: string, grant: "none" | "member") {
			const { workspace, user, token } = await seedFixture({ role: workspaceRole });
			const project = await seedProject(workspace.id);
			const g =
				grant === "member"
					? await seedGroupGrant(workspace.id, user.id, project.id, "member")
					: null;
			const issue = await seedIssue(workspace.id, project.id, user.id, { title: "Shared" });
			const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}/share`, {
				method: "POST",
				headers: authHeaders(token, workspace.slug),
			});
			expect(res.status).toBe(201);
			const { token: shareToken } = (await res.json()) as { token: string };
			return {
				shareToken,
				workspaceId: workspace.id,
				userId: user.id,
				projectId: project.id,
				issueId: issue.id,
				groupId: g?.groupId ?? null,
			};
		}

		async function shareStatus(shareToken: string): Promise<number> {
			// The public share route is rate-limited too; these tests hit it several times.
			await resetRateLimits();
			return (await SELF.fetch(`http://localhost/api/share/${shareToken}`)).status;
		}

		it("404s once the issue is deleted", async () => {
			const f = await sharedIssue("admin", "none");
			expect(await shareStatus(f.shareToken)).toBe(200);
			await env.DB.prepare("DELETE FROM issues WHERE id = ?").bind(f.issueId).run();
			expect(await shareStatus(f.shareToken)).toBe(404);
		});

		it("404s once the issue's project is archived", async () => {
			const f = await sharedIssue("admin", "none");
			expect(await shareStatus(f.shareToken)).toBe(200);
			await env.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
				.bind(Math.floor(Date.now() / 1000), f.projectId)
				.run();
			expect(await shareStatus(f.shareToken)).toBe(404);
		});

		it("404s once the creator's project grant is revoked, and resolves again if restored", async () => {
			const f = await sharedIssue("member", "member");
			expect(await shareStatus(f.shareToken)).toBe(200);

			const grant = await env.DB.prepare(
				"SELECT role FROM group_project_grants WHERE group_id = ? AND project_id = ?"
			)
				.bind(f.groupId, f.projectId)
				.first<{ role: string }>();
			await env.DB.prepare("DELETE FROM group_project_grants WHERE group_id = ? AND project_id = ?")
				.bind(f.groupId, f.projectId)
				.run();
			expect(await shareStatus(f.shareToken)).toBe(404);
			await resetRateLimits();
			expect((await SELF.fetch(`http://localhost/api/share/${f.shareToken}/logo`)).status).toBe(
				404
			);

			await env.DB.prepare(
				"INSERT INTO group_project_grants (group_id, project_id, role) VALUES (?, ?, ?)"
			)
				.bind(f.groupId, f.projectId, grant?.role ?? "member")
				.run();
			expect(await shareStatus(f.shareToken)).toBe(200);
		});

		it("404s once the creator is removed from the workspace", async () => {
			const f = await sharedIssue("admin", "none");
			expect(await shareStatus(f.shareToken)).toBe(200);
			await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
				.bind(f.workspaceId, f.userId)
				.run();
			expect(await shareStatus(f.shareToken)).toBe(404);
		});
	});
});
