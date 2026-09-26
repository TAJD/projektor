import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedGroupGrant,
	seedMember,
	seedProject,
	seedToken,
	seedUser,
} from "./helpers";

// PROJ-821: a watcher who loses access to a page (grant revoked, or removed from the
// workspace) must stop receiving its notifications, which carry the page title.
describe("wiki watch notifications respect current access (PROJ-821)", () => {
	let adminToken: string;
	let slug: string;
	let workspaceId: string;
	let watcherId: string;
	let watcherToken: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "admin" });
		adminToken = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		const watcher = await seedUser(`w-${crypto.randomUUID().slice(0, 8)}@example.com`);
		watcherId = watcher.id;
		await seedMember(workspaceId, watcherId, "member");
		watcherToken = await seedToken(workspaceId, watcherId);
	});

	async function createPage(body: Record<string, unknown>): Promise<string> {
		const res = await SELF.fetch("http://localhost/api/wiki", {
			method: "POST",
			headers: authHeaders(adminToken, slug),
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(201);
		return ((await res.json()) as { id: string }).id;
	}

	async function watch(pageId: string): Promise<void> {
		const res = await SELF.fetch(`http://localhost/api/wiki/${pageId}/watch`, {
			method: "POST",
			headers: authHeaders(watcherToken, slug),
			body: JSON.stringify({}),
		});
		expect(res.status).toBeLessThan(300);
	}

	async function edit(pageId: string, content: string): Promise<void> {
		await env.DB.prepare("DELETE FROM rate_limit").run();
		const res = await SELF.fetch(`http://localhost/api/wiki/${pageId}`, {
			method: "PUT",
			headers: authHeaders(adminToken, slug),
			body: JSON.stringify({ content }),
		});
		expect(res.status).toBe(200);
	}

	async function notificationCount(): Promise<number> {
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM wiki_notifications WHERE user_id = ? AND workspace_id = ?"
		)
			.bind(watcherId, workspaceId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	it("stops notifying a watcher once their group's project grant is revoked", async () => {
		const project = await seedProject(workspaceId);
		const { groupId } = await seedGroupGrant(workspaceId, watcherId, project.id, "viewer");
		const pageId = await createPage({ title: "Secret Plan", content: "v1", projectId: project.id });
		await watch(pageId);

		await edit(pageId, "v2");
		expect(await notificationCount()).toBe(1);

		await env.DB.prepare("DELETE FROM group_project_grants WHERE group_id = ? AND project_id = ?")
			.bind(groupId, project.id)
			.run();

		await edit(pageId, "v3");
		expect(await notificationCount()).toBe(1);
	});

	it("stops notifying a watcher removed from the workspace, even for workspace-level pages", async () => {
		const pageId = await createPage({ title: "Handbook", content: "v1" });
		await watch(pageId);

		await edit(pageId, "v2");
		expect(await notificationCount()).toBe(1);

		await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.bind(workspaceId, watcherId)
			.run();

		await edit(pageId, "v3");
		expect(await notificationCount()).toBe(1);
	});

	it("still notifies a subtree watcher who keeps access", async () => {
		const project = await seedProject(workspaceId);
		await seedGroupGrant(workspaceId, watcherId, project.id, "viewer");
		const parentId = await createPage({ title: "Parent", content: "p", projectId: project.id });
		const res = await SELF.fetch(`http://localhost/api/wiki/${parentId}/watch`, {
			method: "POST",
			headers: authHeaders(watcherToken, slug),
			body: JSON.stringify({ subtree: true }),
		});
		expect(res.status).toBeLessThan(300);

		await env.DB.prepare("DELETE FROM rate_limit").run();
		await createPage({ title: "Child", content: "c", parentId, projectId: project.id });
		expect(await notificationCount()).toBe(1);
	});
});
