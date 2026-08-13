import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedIssue,
	seedMember,
	seedProjectFixture,
	seedTaskStatus,
	seedToken,
	seedUser,
} from "./helpers";

describe("Task Statuses API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	// ---- list ----

	it("GET /api/task-statuses returns empty list initially", async () => {
		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const list = (await res.json()) as unknown[];
		expect(Array.isArray(list)).toBe(true);
		expect(list).toHaveLength(0);
	});

	it("GET /api/task-statuses returns seeded statuses ordered by position", async () => {
		await seedTaskStatus(workspaceId, { key: "done", name: "Done", category: "done", position: 2 });
		await seedTaskStatus(workspaceId, { key: "todo", name: "Todo", category: "todo", position: 1 });

		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			headers: authHeaders(token, slug),
		});
		const list = (await res.json()) as Array<{ key: string }>;
		expect(list).toHaveLength(2);
		expect(list[0].key).toBe("todo");
		expect(list[1].key).toBe("done");
	});

	// ---- create ----

	it("POST /api/task-statuses creates a new status (owner)", async () => {
		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				key: "in_progress",
				name: "In Progress",
				category: "in_progress",
				position: 1,
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; key: string };
		expect(body.id).toBeTruthy();
		expect(body.key).toBe("in_progress");
	});

	it("POST /api/task-statuses rejects duplicate key", async () => {
		await seedTaskStatus(workspaceId, { key: "done", name: "Done", category: "done" });
		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "done", name: "Done 2", category: "done" }),
		});
		expect(res.status).toBe(409);
	});

	it("POST /api/task-statuses rejects invalid key format", async () => {
		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "Bad Key!", name: "Bad", category: "todo" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/task-statuses clears other defaults when isDefault=true", async () => {
		await seedTaskStatus(workspaceId, {
			key: "todo",
			name: "Todo",
			category: "todo",
			isDefault: true,
		});

		await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "backlog", name: "Backlog", category: "todo", isDefault: true }),
		});

		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			headers: authHeaders(token, slug),
		});
		const list = (await res.json()) as Array<{ key: string; is_default: number }>;
		const defaults = list.filter((s) => s.is_default === 1);
		expect(defaults).toHaveLength(1);
		expect(defaults[0].key).toBe("backlog");
	});

	it("POST /api/task-statuses returns 403 for member role", async () => {
		const memberUser = await seedUser("member@example.com");
		await seedMember(workspaceId, memberUser.id, "member");
		const memberToken = await seedToken(workspaceId, memberUser.id);

		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			method: "POST",
			headers: authHeaders(memberToken, slug),
			body: JSON.stringify({ key: "done", name: "Done", category: "done" }),
		});
		expect(res.status).toBe(403);
	});

	// ---- update ----

	it("PATCH /api/task-statuses/:id updates name", async () => {
		const { id } = await seedTaskStatus(workspaceId, {
			key: "todo",
			name: "Todo",
			category: "todo",
		});

		const res = await SELF.fetch(`http://localhost/api/task-statuses/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "To Do" }),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch("http://localhost/api/task-statuses", {
			headers: authHeaders(token, slug),
		});
		const list = (await listRes.json()) as Array<{ key: string; name: string }>;
		expect(list.find((s) => s.key === "todo")?.name).toBe("To Do");
	});

	it("PATCH /api/task-statuses/:id returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/task-statuses/${crypto.randomUUID()}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ name: "Ghost" }),
		});
		expect(res.status).toBe(404);
	});

	it("PATCH /api/task-statuses/:id with isDefault=true clears others", async () => {
		const { id: todoId } = await seedTaskStatus(workspaceId, {
			key: "todo",
			name: "Todo",
			category: "todo",
			isDefault: true,
		});
		const { id: doneId } = await seedTaskStatus(workspaceId, {
			key: "done",
			name: "Done",
			category: "done",
		});

		await SELF.fetch(`http://localhost/api/task-statuses/${doneId}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ isDefault: true }),
		});

		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			headers: authHeaders(token, slug),
		});
		const list = (await res.json()) as Array<{ id: string; is_default: number }>;
		const todoRow = list.find((s) => s.id === todoId);
		const doneRow = list.find((s) => s.id === doneId);
		expect(todoRow?.is_default).toBe(0);
		expect(doneRow?.is_default).toBe(1);
	});

	// ---- delete ----

	it("DELETE /api/task-statuses/:id removes a status", async () => {
		const { id } = await seedTaskStatus(workspaceId, {
			key: "cancelled",
			name: "Cancelled",
			category: "cancelled",
		});

		const res = await SELF.fetch(`http://localhost/api/task-statuses/${id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch("http://localhost/api/task-statuses", {
			headers: authHeaders(token, slug),
		});
		const list = (await listRes.json()) as unknown[];
		expect(list).toHaveLength(0);
	});

	it("DELETE /api/task-statuses/:id returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/task-statuses/${crypto.randomUUID()}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
	});

	it("DELETE /api/task-statuses/:id returns 409 when status is in use", async () => {
		const { id: statusId } = await seedTaskStatus(workspaceId, {
			key: "done",
			name: "Done",
			category: "done",
		});
		await seedIssue(workspaceId, projectId, userId, { statusId });

		const res = await SELF.fetch(`http://localhost/api/task-statuses/${statusId}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(409);
	});

	it("DELETE /api/task-statuses/:id returns 409 when deleting the default", async () => {
		const { id } = await seedTaskStatus(workspaceId, {
			key: "backlog",
			name: "Backlog",
			category: "todo",
			isDefault: true,
		});

		const res = await SELF.fetch(`http://localhost/api/task-statuses/${id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(409);
	});

	// ---- workspace scoping ----

	it("GET /api/task-statuses is workspace-scoped", async () => {
		await seedTaskStatus(workspaceId, { key: "done", name: "Done", category: "done" });
		const other = await seedFixture({ role: "owner" });

		const res = await SELF.fetch("http://localhost/api/task-statuses", {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		const list = (await res.json()) as unknown[];
		expect(list).toHaveLength(0);
	});
});

describe("Task Statuses — issue integration", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	it("POST /api/issues uses workspace default status when no statusId given", async () => {
		await seedTaskStatus(workspaceId, {
			key: "backlog",
			name: "Backlog",
			category: "todo",
			isDefault: true,
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "No status given" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as {
			status_key: string;
			status_name: string;
			status_category: string;
		};
		expect(issue.status_key).toBe("backlog");
		expect(issue.status_name).toBe("Backlog");
		expect(issue.status_category).toBe("todo");
	});

	it("POST /api/issues with statusId sets the status_id", async () => {
		const { id: statusId } = await seedTaskStatus(workspaceId, {
			key: "done",
			name: "Done",
			category: "done",
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Done issue", statusId }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { status_key: string; status_id: string };
		expect(issue.status_key).toBe("done");
		expect(issue.status_id).toBe(statusId);
	});

	it("POST /api/issues with legacy status string sets status_id via key lookup", async () => {
		await seedTaskStatus(workspaceId, {
			key: "in_progress",
			name: "In Progress",
			category: "in_progress",
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Legacy status", status: "in_progress" }),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${id}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { status: string; status_key: string };
		expect(issue.status).toBe("in_progress");
		expect(issue.status_key).toBe("in_progress");
	});

	it("POST /api/issues rejects statusId from another workspace", async () => {
		const other = await seedFixture({ role: "owner" });
		const { id: foreignStatusId } = await seedTaskStatus(other.workspace.id, {
			key: "done",
			name: "Done",
			category: "done",
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Cross-ws status", statusId: foreignStatusId }),
		});
		expect(res.status).toBe(400);
	});

	it("PATCH /api/issues/:id updates statusId", async () => {
		const { id: statusId } = await seedTaskStatus(workspaceId, {
			key: "done",
			name: "Done",
			category: "done",
		});
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "No status" });

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				statusId,
				completionReport: { summary: "Done", verification: "pnpm test" },
			}),
		});
		expect(res.status).toBe(200);

		const getRes = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		const updated = (await getRes.json()) as { status_key: string };
		expect(updated.status_key).toBe("done");
	});

	it("GET /api/issues?statusId= filters by statusId", async () => {
		const { id: doneId } = await seedTaskStatus(workspaceId, {
			key: "done",
			name: "Done",
			category: "done",
		});
		const { id: todoId } = await seedTaskStatus(workspaceId, {
			key: "todo",
			name: "Todo",
			category: "todo",
		});

		await seedIssue(workspaceId, projectId, userId, { title: "Done 1", statusId: doneId });
		await seedIssue(workspaceId, projectId, userId, { title: "Done 2", statusId: doneId });
		await seedIssue(workspaceId, projectId, userId, { title: "Todo 1", statusId: todoId });

		const res = await SELF.fetch(`http://localhost/api/issues?statusId=${doneId}`, {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { items: Array<{ title: string }> };
		expect(page.items).toHaveLength(2);
		expect(page.items.every((i) => i.title.startsWith("Done"))).toBe(true);
	});

	it("GET /api/issues?category= filters by category", async () => {
		const { id: doneId } = await seedTaskStatus(workspaceId, {
			key: "done",
			name: "Done",
			category: "done",
		});
		const { id: todoId } = await seedTaskStatus(workspaceId, {
			key: "todo",
			name: "Todo",
			category: "todo",
		});
		const { id: inProgressId } = await seedTaskStatus(workspaceId, {
			key: "in_progress",
			name: "In Progress",
			category: "in_progress",
		});

		await seedIssue(workspaceId, projectId, userId, { title: "Done issue", statusId: doneId });
		await seedIssue(workspaceId, projectId, userId, { title: "Todo issue", statusId: todoId });
		await seedIssue(workspaceId, projectId, userId, {
			title: "In Progress issue",
			statusId: inProgressId,
		});

		const res = await SELF.fetch("http://localhost/api/issues?category=todo", {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { items: Array<{ title: string }> };
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("Todo issue");
	});

	it("GET /api/issues?status= (legacy) still works", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "Backlog issue", status: "backlog" });
		await seedIssue(workspaceId, projectId, userId, { title: "Done issue", status: "done" });

		const res = await SELF.fetch("http://localhost/api/issues?status=backlog", {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { items: Array<{ title: string }> };
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("Backlog issue");
	});

	it("GET /api/issues returns status_key, status_name, status_category in list", async () => {
		const { id: statusId } = await seedTaskStatus(workspaceId, {
			key: "done",
			name: "Done",
			category: "done",
		});
		await seedIssue(workspaceId, projectId, userId, { title: "Done issue", statusId });

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as {
			items: Array<{ status_key: string; status_name: string; status_category: string }>;
		};
		expect(page.items[0].status_key).toBe("done");
		expect(page.items[0].status_name).toBe("Done");
		expect(page.items[0].status_category).toBe("done");
	});

	it("GET /api/issues/:id returns status_key, status_name, status_category", async () => {
		const { id: statusId } = await seedTaskStatus(workspaceId, {
			key: "in_progress",
			name: "In Progress",
			category: "in_progress",
		});
		const issue = await seedIssue(workspaceId, projectId, userId, { statusId });

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as {
			status_key: string;
			status_name: string;
			status_category: string;
		};
		expect(body.status_key).toBe("in_progress");
		expect(body.status_name).toBe("In Progress");
		expect(body.status_category).toBe("in_progress");
	});

	it("GET /api/issues/:id has null status_key when no status_id set", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId, { title: "No status_id" });

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as { status_id: null; status_key: null };
		expect(body.status_id).toBeNull();
		expect(body.status_key).toBeNull();
	});
});

describe("Task Statuses — MCP parity", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	async function mcpCall(method: string, params: unknown) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		return res.json() as Promise<{
			result?: { content: Array<{ text: string }> };
			error?: { message: string };
		}>;
	}

	it("list_task_statuses returns empty list", async () => {
		const resp = await mcpCall("tools/call", { name: "list_task_statuses", arguments: {} });
		expect(resp.error).toBeUndefined();
		const data = JSON.parse(resp.result!.content[0].text) as unknown[];
		expect(Array.isArray(data)).toBe(true);
		expect(data).toHaveLength(0);
	});

	it("create_task_status then list returns the status", async () => {
		await mcpCall("tools/call", {
			name: "create_task_status",
			arguments: { key: "done", name: "Done", category: "done", position: 1 },
		});
		const resp = await mcpCall("tools/call", { name: "list_task_statuses", arguments: {} });
		const data = JSON.parse(resp.result!.content[0].text) as Array<{ key: string }>;
		expect(data).toHaveLength(1);
		expect(data[0].key).toBe("done");
	});

	it("delete_task_status via MCP returns ok", async () => {
		const createResp = await mcpCall("tools/call", {
			name: "create_task_status",
			arguments: { key: "tmp", name: "Tmp", category: "cancelled" },
		});
		const created = JSON.parse(createResp.result!.content[0].text) as { id: string };

		const deleteResp = await mcpCall("tools/call", {
			name: "delete_task_status",
			arguments: { id: created.id },
		});
		const deleted = JSON.parse(deleteResp.result!.content[0].text) as { ok: boolean };
		expect(deleted.ok).toBe(true);
	});
});
