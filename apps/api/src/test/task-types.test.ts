import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedIssue,
	seedMember,
	seedProjectFixture,
	seedTaskType,
	seedToken,
	seedUser,
} from "./helpers";

describe("Task Types API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;

	beforeEach(async () => {
		// seedFixture uses seedWorkspace (raw insert, no seeding of task types)
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	// ---- list ----

	it("GET /api/task-types returns empty list initially", async () => {
		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const list = (await res.json()) as unknown[];
		expect(Array.isArray(list)).toBe(true);
		expect(list).toHaveLength(0);
	});

	it("GET /api/task-types returns seeded types ordered by position", async () => {
		await seedTaskType(workspaceId, { key: "bug", name: "Bug", position: 2 });
		await seedTaskType(workspaceId, { key: "task", name: "Task", position: 1, isDefault: true });

		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: authHeaders(token, slug),
		});
		const list = (await res.json()) as Array<{ key: string }>;
		expect(list).toHaveLength(2);
		expect(list[0].key).toBe("task");
		expect(list[1].key).toBe("bug");
	});

	// ---- create ----

	it("POST /api/task-types creates a new type (owner)", async () => {
		const res = await SELF.fetch("http://localhost/api/task-types", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "epic", name: "Epic", position: 1 }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; key: string };
		expect(body.id).toBeTruthy();
		expect(body.key).toBe("epic");
	});

	it("POST /api/task-types rejects duplicate key", async () => {
		await seedTaskType(workspaceId, { key: "epic", name: "Epic" });
		const res = await SELF.fetch("http://localhost/api/task-types", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "epic", name: "Epic 2" }),
		});
		expect(res.status).toBe(409);
	});

	it("POST /api/task-types rejects invalid key format", async () => {
		const res = await SELF.fetch("http://localhost/api/task-types", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "Bad Key!", name: "Bad" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/task-types clears other defaults when isDefault=true", async () => {
		await seedTaskType(workspaceId, { key: "task", name: "Task", isDefault: true });

		await SELF.fetch("http://localhost/api/task-types", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "story", name: "Story", isDefault: true }),
		});

		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: authHeaders(token, slug),
		});
		const list = (await res.json()) as Array<{ key: string; is_default: number }>;
		const defaults = list.filter((t) => t.is_default === 1);
		expect(defaults).toHaveLength(1);
		expect(defaults[0].key).toBe("story");
	});

	it("POST /api/task-types returns 403 for member role", async () => {
		const memberUser = await seedUser("member@example.com");
		await seedMember(workspaceId, memberUser.id, "member");
		const memberToken = await seedToken(workspaceId, memberUser.id);

		const res = await SELF.fetch("http://localhost/api/task-types", {
			method: "POST",
			headers: authHeaders(memberToken, slug),
			body: JSON.stringify({ key: "epic", name: "Epic" }),
		});
		expect(res.status).toBe(403);
	});

	// ---- update ----

	it("PATCH /api/task-types/:id updates name", async () => {
		const { id } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });

		const res = await SELF.fetch(`http://localhost/api/task-types/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "Defect" }),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch("http://localhost/api/task-types", {
			headers: authHeaders(token, slug),
		});
		const list = (await listRes.json()) as Array<{ key: string; name: string }>;
		expect(list.find((t) => t.key === "bug")?.name).toBe("Defect");
	});

	it("PATCH /api/task-types/:id returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/task-types/${crypto.randomUUID()}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "Ghost" }),
		});
		expect(res.status).toBe(404);
	});

	it("PATCH /api/task-types/:id with isDefault=true clears others", async () => {
		const { id: taskId } = await seedTaskType(workspaceId, {
			key: "task",
			name: "Task",
			isDefault: true,
		});
		const { id: bugId } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });

		await SELF.fetch(`http://localhost/api/task-types/${bugId}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ isDefault: true }),
		});

		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: authHeaders(token, slug),
		});
		const list = (await res.json()) as Array<{ id: string; is_default: number }>;
		const taskRow = list.find((t) => t.id === taskId);
		const bugRow = list.find((t) => t.id === bugId);
		expect(taskRow?.is_default).toBe(0);
		expect(bugRow?.is_default).toBe(1);
	});

	// ---- delete ----

	it("DELETE /api/task-types/:id removes a type", async () => {
		const { id } = await seedTaskType(workspaceId, { key: "epic", name: "Epic" });

		const res = await SELF.fetch(`http://localhost/api/task-types/${id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch("http://localhost/api/task-types", {
			headers: authHeaders(token, slug),
		});
		const list = (await listRes.json()) as unknown[];
		expect(list).toHaveLength(0);
	});

	it("DELETE /api/task-types/:id returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/task-types/${crypto.randomUUID()}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("DELETE /api/task-types/:id returns 409 when type is in use", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "epic", name: "Epic" });
		await seedIssue(workspaceId, projectId, userId, { typeId });

		const res = await SELF.fetch(`http://localhost/api/task-types/${typeId}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(409);
	});

	// ---- workspace scoping ----

	it("GET /api/task-types is workspace-scoped", async () => {
		await seedTaskType(workspaceId, { key: "epic", name: "Epic" });
		const other = await seedFixture({ role: "owner" });

		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		const list = (await res.json()) as unknown[];
		expect(list).toHaveLength(0);
	});
});

describe("Task Types — issue integration", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	it("POST /api/issues uses workspace default type when no typeId given", async () => {
		await seedTaskType(workspaceId, { key: "task", name: "Task", isDefault: true });

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "No type given" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { type_key: string; type_name: string };
		expect(issue.type_key).toBe("task");
		expect(issue.type_name).toBe("Task");
	});

	it("POST /api/issues with typeId sets the type", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Bug issue", typeId }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { type_key: string };
		expect(issue.type_key).toBe("bug");
	});

	it("POST /api/issues rejects typeId from another workspace", async () => {
		const other = await seedFixture({ role: "owner" });
		const { id: foreignTypeId } = await seedTaskType(other.workspace.id, {
			key: "epic",
			name: "Epic",
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Cross-ws type", typeId: foreignTypeId }),
		});
		expect(res.status).toBe(400);
	});

	it("PATCH /api/issues/:id updates typeId", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "story", name: "Story" });
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "No type" });

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ typeId }),
		});
		expect(res.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		const updated = (await getRes.json()) as { type_key: string };
		expect(updated.type_key).toBe("story");
	});

	it("PATCH /api/issues/:id clears typeId with null", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });
		const issue = await seedIssue(workspaceId, projectId, userId, { typeId });

		await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ typeId: null }),
		});

		const getRes = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		const updated = (await getRes.json()) as { type_id: string | null; type_key: string | null };
		expect(updated.type_id).toBeNull();
		expect(updated.type_key).toBeNull();
	});

	it("GET /api/issues?typeId= filters by type", async () => {
		const { id: bugTypeId } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });
		const { id: storyTypeId } = await seedTaskType(workspaceId, { key: "story", name: "Story" });

		await seedIssue(workspaceId, projectId, userId, { title: "Bug 1", typeId: bugTypeId });
		await seedIssue(workspaceId, projectId, userId, { title: "Bug 2", typeId: bugTypeId });
		await seedIssue(workspaceId, projectId, userId, { title: "Story 1", typeId: storyTypeId });

		const res = await SELF.fetch(`http://localhost/api/issues?typeId=${bugTypeId}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { items: Array<{ title: string }> };
		expect(page.items).toHaveLength(2);
		expect(page.items.every((i) => i.title.startsWith("Bug"))).toBe(true);
	});

	it("GET /api/issues returns type_key and type_name in list", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "epic", name: "Epic" });
		await seedIssue(workspaceId, projectId, userId, { title: "Typed issue", typeId });

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { items: Array<{ type_key: string; type_name: string }> };
		expect(page.items[0].type_key).toBe("epic");
		expect(page.items[0].type_name).toBe("Epic");
	});

	it("GET /api/issues/:id returns type_key and type_name", async () => {
		const { id: typeId } = await seedTaskType(workspaceId, { key: "bug", name: "Bug" });
		const issue = await seedIssue(workspaceId, projectId, userId, { typeId });

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as { type_key: string; type_name: string };
		expect(body.type_key).toBe("bug");
		expect(body.type_name).toBe("Bug");
	});

	it("POST /api/issues has null type_key when no types exist", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Typeless issue" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { type_id: null; type_key: null };
		expect(issue.type_id).toBeNull();
		expect(issue.type_key).toBeNull();
	});
});

describe("Task Types — MCP parity", () => {
	let token: string;
	let slug: string;
	let _workspaceId: string;
	let workspaceNumericId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		_workspaceId = fixture.workspace.id;
		workspaceNumericId = fixture.workspace.id;
	});

	async function mcpCall(method: string, params: unknown) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceNumericId}`, {
			method: "POST",
			headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		return res.json() as Promise<{
			result?: { content: Array<{ text: string }> };
			error?: { message: string };
		}>;
	}

	it("list_task_types returns empty list", async () => {
		const resp = await mcpCall("tools/call", { name: "list_task_types", arguments: {} });
		expect(resp.error).toBeUndefined();
		const data = JSON.parse(resp.result!.content[0].text) as unknown[];
		expect(Array.isArray(data)).toBe(true);
		expect(data).toHaveLength(0);
	});

	it("create_task_type then list_task_types returns the type", async () => {
		await mcpCall("tools/call", {
			name: "create_task_type",
			arguments: { key: "epic", name: "Epic", position: 1 },
		});
		const resp = await mcpCall("tools/call", { name: "list_task_types", arguments: {} });
		const data = JSON.parse(resp.result!.content[0].text) as Array<{ key: string }>;
		expect(data).toHaveLength(1);
		expect(data[0].key).toBe("epic");
	});

	it("delete_task_type via MCP returns ok", async () => {
		const createResp = await mcpCall("tools/call", {
			name: "create_task_type",
			arguments: { key: "tmp", name: "Tmp" },
		});
		const created = JSON.parse(createResp.result!.content[0].text) as { id: string };

		const deleteResp = await mcpCall("tools/call", {
			name: "delete_task_type",
			arguments: { id: created.id },
		});
		const deleted = JSON.parse(deleteResp.result!.content[0].text) as { ok: boolean };
		expect(deleted.ok).toBe(true);
	});
});
