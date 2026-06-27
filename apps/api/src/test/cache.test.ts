import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedIssue,
	seedProject,
	seedTaskStatus,
	seedTaskType,
} from "./helpers";

describe("KV caching", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
		userId = fixture.user.id;
		const project = await seedProject(workspaceId);
		projectId = project.id;
	});

	describe("single-issue cache (TTL 300s, write-through invalidation)", () => {
		it("cache hit skips D1 — second GET returns cached data even after D1 row is gone", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Cached Issue" });
			const url = `http://localhost/api/issues/${issue.id}`;
			const hdrs = authHeaders(token, slug);

			// First GET — populates cache
			const first = await SELF.fetch(url, { headers: hdrs });
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as { id: string; title: string };
			expect(firstBody.title).toBe("Cached Issue");

			// Delete D1 row — simulates D1 being unavailable or stale
			await env.DB.prepare("DELETE FROM issues WHERE id = ?").bind(issue.id).run();

			// Second GET — should return from KV cache, not 404
			const second = await SELF.fetch(url, { headers: hdrs });
			expect(second.status).toBe(200);
			const secondBody = (await second.json()) as { id: string; title: string };
			expect(secondBody.id).toBe(issue.id);
			expect(secondBody.title).toBe("Cached Issue");
		});

		it("updateIssue invalidates the cache — subsequent GET reflects updated data", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: "Before" });
			const url = `http://localhost/api/issues/${issue.id}`;
			const hdrs = authHeaders(token, slug);

			// GET to populate cache
			await SELF.fetch(url, { headers: hdrs });

			// PATCH to update — should invalidate the cache entry
			const patch = await SELF.fetch(url, {
				method: "PATCH",
				headers: hdrs,
				body: JSON.stringify({ title: "After" }),
			});
			expect(patch.status).toBe(200);

			// GET — cache was invalidated so this reads from D1 and returns the new title
			const res = await SELF.fetch(url, { headers: hdrs });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { title: string };
			expect(body.title).toBe("After");
		});

		it("deleteIssue invalidates the cache — subsequent GET returns 404, not stale cache", async () => {
			const issue = await seedIssue(workspaceId, projectId, userId);
			const url = `http://localhost/api/issues/${issue.id}`;
			const hdrs = authHeaders(token, slug);

			// GET to populate cache
			await SELF.fetch(url, { headers: hdrs });

			// DELETE — should invalidate the cache entry
			const del = await SELF.fetch(url, { method: "DELETE", headers: hdrs });
			expect(del.status).toBe(200);

			// GET after delete must return 404, not the stale cached value
			const res = await SELF.fetch(url, { headers: hdrs });
			expect(res.status).toBe(404);
		});
	});

	describe("workspace metadata cache (TTL 60s, no invalidation)", () => {
		it("task statuses list is cached — second GET returns data even after D1 is cleared", async () => {
			await seedTaskStatus(workspaceId, { key: "todo", name: "Todo", category: "todo" });
			const url = "http://localhost/api/task-statuses";
			const hdrs = authHeaders(token, slug);

			// First GET — populates cache
			const first = await SELF.fetch(url, { headers: hdrs });
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as unknown[];
			expect(firstBody.length).toBeGreaterThan(0);

			// Delete all task statuses from D1
			await env.DB.prepare("DELETE FROM task_statuses WHERE workspace_id = ?")
				.bind(workspaceId)
				.run();

			// Second GET — served from KV cache
			const second = await SELF.fetch(url, { headers: hdrs });
			expect(second.status).toBe(200);
			const secondBody = (await second.json()) as unknown[];
			expect(secondBody.length).toBeGreaterThan(0);
		});

		it("task types list is cached — second GET returns data even after D1 is cleared", async () => {
			await seedTaskType(workspaceId, { key: "bug", name: "Bug" });
			const url = "http://localhost/api/task-types";
			const hdrs = authHeaders(token, slug);

			const first = await SELF.fetch(url, { headers: hdrs });
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as unknown[];
			expect(firstBody.length).toBeGreaterThan(0);

			await env.DB.prepare("DELETE FROM task_types WHERE workspace_id = ?")
				.bind(workspaceId)
				.run();

			const second = await SELF.fetch(url, { headers: hdrs });
			expect(second.status).toBe(200);
			const secondBody = (await second.json()) as unknown[];
			expect(secondBody.length).toBeGreaterThan(0);
		});

		it("projects list is cached — MCP list_projects returns data even after D1 is cleared", async () => {
			// projectId was already seeded in beforeEach via seedProject
			const hdrs = authHeaders(token, slug);
			const mcpUrl = `http://localhost/mcp/${workspaceId}`;

			async function mcpListProjects() {
				const res = await SELF.fetch(mcpUrl, {
					method: "POST",
					headers: hdrs,
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name: "list_projects", arguments: {} },
					}),
				});
				const rpc = (await res.json()) as { result: { content: Array<{ text: string }> } };
				return JSON.parse(rpc.result.content[0].text) as unknown[];
			}

			// First call — populates cache
			const first = await mcpListProjects();
			expect(first.length).toBeGreaterThan(0);

			// Delete from D1 — cache should serve the next request
			await env.DB.prepare("DELETE FROM projects WHERE workspace_id = ?")
				.bind(workspaceId)
				.run();

			// Second call — served from KV cache
			const second = await mcpListProjects();
			expect(second.length).toBeGreaterThan(0);
		});
	});
});
