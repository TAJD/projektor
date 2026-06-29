import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { batchLoadCustomFields } from "../services/custom-fields";
import {
	authHeaders,
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedFixture,
	seedIssue,
	seedMember,
	seedProject,
	seedToken,
	seedUser,
} from "./helpers";

// ─── Definition CRUD ──────────────────────────────────────────────────────────

describe("Custom Field Definitions API", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	it("GET /api/custom-fields returns empty list initially", async () => {
		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const list = (await res.json()) as unknown[];
		expect(Array.isArray(list)).toBe(true);
		expect(list).toHaveLength(0);
	});

	it("POST /api/custom-fields creates a text field (owner)", async () => {
		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "sprint", label: "Sprint", type: "text" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; key: string };
		expect(body.id).toBeTruthy();
		expect(body.key).toBe("sprint");
	});

	it("POST /api/custom-fields creates a number field", async () => {
		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "story_points", label: "Story Points", type: "number" }),
		});
		expect(res.status).toBe(201);
	});

	it("POST /api/custom-fields creates a select field with options", async () => {
		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				key: "size",
				label: "Size",
				type: "select",
				options: ["S", "M", "L"],
			}),
		});
		expect(res.status).toBe(201);
	});

	it("POST /api/custom-fields rejects duplicate key", async () => {
		await seedCustomFieldDef(workspaceId, { key: "sprint", type: "text" });
		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "sprint", label: "Sprint 2", type: "text" }),
		});
		expect(res.status).toBe(409);
	});

	it("POST /api/custom-fields rejects invalid key format", async () => {
		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ key: "Bad Key!", label: "Bad", type: "text" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/custom-fields returns 403 for member role", async () => {
		const memberUser = await seedUser("member@example.com");
		await seedMember(workspaceId, memberUser.id, "member");
		const memberToken = await seedToken(workspaceId, memberUser.id);

		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			method: "POST",
			headers: authHeaders(memberToken, slug),
			body: JSON.stringify({ key: "sprint", label: "Sprint", type: "text" }),
		});
		expect(res.status).toBe(403);
	});

	it("PATCH /api/custom-fields/:id updates label", async () => {
		const { id } = await seedCustomFieldDef(workspaceId, {
			key: "sp",
			label: "Story Points",
			type: "number",
		});

		const res = await SELF.fetch(`http://localhost/api/custom-fields/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ label: "Points" }),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch("http://localhost/api/custom-fields", {
			headers: authHeaders(token, slug),
		});
		const list = (await listRes.json()) as Array<{ key: string; label: string }>;
		expect(list.find((f) => f.key === "sp")?.label).toBe("Points");
	});

	it("PATCH /api/custom-fields/:id updates options for select field", async () => {
		const { id } = await seedCustomFieldDef(workspaceId, {
			key: "size",
			type: "select",
			options: ["S", "M"],
		});

		const res = await SELF.fetch(`http://localhost/api/custom-fields/${id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ options: ["S", "M", "L", "XL"] }),
		});
		expect(res.status).toBe(200);
	});

	it("PATCH /api/custom-fields/:id returns 404 for unknown id", async () => {
		const res = await SELF.fetch(`http://localhost/api/custom-fields/${crypto.randomUUID()}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ label: "Ghost" }),
		});
		expect(res.status).toBe(404);
	});

	it("DELETE /api/custom-fields/:id removes a field", async () => {
		const { id } = await seedCustomFieldDef(workspaceId, { key: "sprint", type: "text" });

		const res = await SELF.fetch(`http://localhost/api/custom-fields/${id}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);

		const listRes = await SELF.fetch("http://localhost/api/custom-fields", {
			headers: authHeaders(token, slug),
		});
		const list = (await listRes.json()) as unknown[];
		expect(list).toHaveLength(0);
	});

	it("DELETE /api/custom-fields/:id returns 409 when in use", async () => {
		const { id: fieldId } = await seedCustomFieldDef(workspaceId, { key: "sprint", type: "text" });
		const project = await seedProject(workspaceId);
		const user = await seedUser("u2@example.com");
		await seedMember(workspaceId, user.id, "member");
		const issue = await seedIssue(workspaceId, project.id, user.id);
		await seedCustomFieldValue(issue.id, fieldId, "sprint-1");

		const res = await SELF.fetch(`http://localhost/api/custom-fields/${fieldId}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(409);
	});

	it("custom fields are workspace-scoped", async () => {
		await seedCustomFieldDef(workspaceId, { key: "sp", type: "number" });
		const other = await seedFixture({ role: "owner" });

		const res = await SELF.fetch("http://localhost/api/custom-fields", {
			headers: authHeaders(other.token, other.workspace.slug),
		});
		const list = (await res.json()) as unknown[];
		expect(list).toHaveLength(0);
	});
});

// ─── Value validation ─────────────────────────────────────────────────────────

describe("Custom Field Values — validation", () => {
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

	it("rejects unknown custom field key on create", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Test", customFields: { unknown_field: "value" } }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects unknown custom field key on update", async () => {
		const issue = await seedIssue(workspaceId, projectId, userId);
		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ customFields: { ghost_field: "5" } }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects non-numeric value for number field", async () => {
		await seedCustomFieldDef(workspaceId, { key: "sp", label: "SP", type: "number" });
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Test", customFields: { sp: "not-a-number" } }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid option for select field", async () => {
		await seedCustomFieldDef(workspaceId, {
			key: "size",
			label: "Size",
			type: "select",
			options: ["S", "M", "L"],
		});
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Test", customFields: { size: "XL" } }),
		});
		expect(res.status).toBe(400);
	});

	it("accepts valid option for select field", async () => {
		await seedCustomFieldDef(workspaceId, {
			key: "size",
			label: "Size",
			type: "select",
			options: ["S", "M", "L"],
		});
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Test", customFields: { size: "M" } }),
		});
		expect(res.status).toBe(201);
	});

	it("accepts valid number for number field", async () => {
		await seedCustomFieldDef(workspaceId, { key: "sp", label: "SP", type: "number" });
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Test", customFields: { sp: "5" } }),
		});
		expect(res.status).toBe(201);
	});

	it("rejects invalid date for date field", async () => {
		await seedCustomFieldDef(workspaceId, { key: "due", label: "Due", type: "date" });
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "Test", customFields: { due: "not-a-date" } }),
		});
		expect(res.status).toBe(400);
	});
});

// ─── Resolved-on-read & batch-load ───────────────────────────────────────────

describe("Custom Fields — resolved on read", () => {
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

	it("GET /api/issues/:id returns customFields array", async () => {
		await seedCustomFieldDef(workspaceId, {
			key: "sp",
			label: "Story Points",
			type: "number",
		});
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "With SP", customFields: { sp: "8" } }),
		});
		const { id: issueId } = (await res.json()) as { id: string };

		const getRes = await SELF.fetch(`http://localhost/api/issues/${issueId}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { customFields: Array<{ key: string; value: string }> };
		expect(Array.isArray(issue.customFields)).toBe(true);
		const sp = issue.customFields.find((f) => f.key === "sp");
		expect(sp?.value).toBe("8");
	});

	it("GET /api/issues list returns customFields per issue (batch-loaded, no N+1)", async () => {
		const { id: fieldId } = await seedCustomFieldDef(workspaceId, {
			key: "sp",
			label: "SP",
			type: "number",
		});

		for (let i = 1; i <= 3; i++) {
			const issue = await seedIssue(workspaceId, projectId, userId, { title: `Issue ${i}` });
			await seedCustomFieldValue(issue.id, fieldId, String(i * 3));
		}

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as {
			items: Array<{ customFields: Array<{ key: string; value: string }> }>;
		};
		expect(page.items).toHaveLength(3);
		for (const item of page.items) {
			expect(Array.isArray(item.customFields)).toBe(true);
			const sp = item.customFields.find((f) => f.key === "sp");
			expect(sp).toBeTruthy();
		}
	});

	it("PATCH /api/issues/:id updates a custom field value", async () => {
		await seedCustomFieldDef(workspaceId, { key: "sp", label: "SP", type: "number" });
		const createRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "SP issue", customFields: { sp: "3" } }),
		});
		const { id: issueId } = (await createRes.json()) as { id: string };

		await SELF.fetch(`http://localhost/api/issues/${issueId}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ customFields: { sp: "13" } }),
		});

		const getRes = await SELF.fetch(`http://localhost/api/issues/${issueId}`, {
			headers: authHeaders(token, slug),
		});
		const issue = (await getRes.json()) as { customFields: Array<{ key: string; value: string }> };
		expect(issue.customFields.find((f) => f.key === "sp")?.value).toBe("13");
	});

	it("issue with no custom field values returns empty customFields array", async () => {
		await seedCustomFieldDef(workspaceId, { key: "sp", label: "SP", type: "number" });
		const issue = await seedIssue(workspaceId, projectId, userId);

		const res = await SELF.fetch(`http://localhost/api/issues/${issue.id}`, {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as { customFields: unknown[] };
		expect(Array.isArray(body.customFields)).toBe(true);
		expect(body.customFields).toHaveLength(0);
	});
});

// ─── Filter by custom field ───────────────────────────────────────────────────

describe("Custom Fields — list_issues filter", () => {
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

	it("GET /api/issues?cfKey=sp&cfOp=eq&cfValue=5 returns matching issues", async () => {
		const { id: fieldId } = await seedCustomFieldDef(workspaceId, {
			key: "sp",
			label: "SP",
			type: "number",
		});

		const i1 = await seedIssue(workspaceId, projectId, userId, { title: "SP5" });
		const i2 = await seedIssue(workspaceId, projectId, userId, { title: "SP8" });
		await seedCustomFieldValue(i1.id, fieldId, "5");
		await seedCustomFieldValue(i2.id, fieldId, "8");

		const res = await SELF.fetch("http://localhost/api/issues?cfKey=sp&cfOp=eq&cfValue=5", {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { items: Array<{ title: string }> };
		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe("SP5");
	});

	it("GET /api/issues?cfKey=sp&cfOp=gt&cfValue=5 returns numeric comparison", async () => {
		const { id: fieldId } = await seedCustomFieldDef(workspaceId, {
			key: "sp",
			label: "SP",
			type: "number",
		});

		const i1 = await seedIssue(workspaceId, projectId, userId, { title: "SP3" });
		const i2 = await seedIssue(workspaceId, projectId, userId, { title: "SP8" });
		const i3 = await seedIssue(workspaceId, projectId, userId, { title: "SP13" });
		await seedCustomFieldValue(i1.id, fieldId, "3");
		await seedCustomFieldValue(i2.id, fieldId, "8");
		await seedCustomFieldValue(i3.id, fieldId, "13");

		const res = await SELF.fetch("http://localhost/api/issues?cfKey=sp&cfOp=gt&cfValue=5", {
			headers: authHeaders(token, slug),
		});
		const page = (await res.json()) as { items: Array<{ title: string }> };
		expect(page.items).toHaveLength(2);
		const titles = page.items.map((i) => i.title).sort();
		expect(titles).toEqual(["SP13", "SP8"]);
	});

	it("GET /api/issues with unknown cfKey returns 400", async () => {
		const res = await SELF.fetch(
			"http://localhost/api/issues?cfKey=nonexistent&cfOp=eq&cfValue=x",
			{
				headers: authHeaders(token, slug),
			}
		);
		expect(res.status).toBe(400);
	});
});

// ─── Story points seed ────────────────────────────────────────────────────────

describe("Custom Fields — story_points seed", () => {
	it("seedDefaultCustomFields creates story_points for new workspace", async () => {
		const { seedDefaultCustomFields } = await import("../services/custom-fields");
		const ws = crypto.randomUUID();
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
			.bind(ws, "Test WS", `seed-test-${ws.slice(0, 8)}`, now)
			.run();

		await seedDefaultCustomFields(env.DB, ws);

		const row = await env.DB.prepare(
			`SELECT key, label, type FROM custom_field_definitions WHERE workspace_id = ? AND key = 'story_points'`
		)
			.bind(ws)
			.first<{ key: string; label: string; type: string }>();
		expect(row).toBeTruthy();
		expect(row!.key).toBe("story_points");
		expect(row!.label).toBe("Story Points");
		expect(row!.type).toBe("number");
	});

	it("seedDefaultCustomFields is idempotent", async () => {
		const { seedDefaultCustomFields } = await import("../services/custom-fields");
		const ws = crypto.randomUUID();
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
			.bind(ws, "Test WS 2", `seed-idempotent-${ws.slice(0, 8)}`, now)
			.run();

		await seedDefaultCustomFields(env.DB, ws);
		await seedDefaultCustomFields(env.DB, ws);

		const { results } = await env.DB.prepare(
			`SELECT id FROM custom_field_definitions WHERE workspace_id = ? AND key = 'story_points'`
		)
			.bind(ws)
			.all();
		expect(results).toHaveLength(1);
	});
});

// ─── MCP parity ──────────────────────────────────────────────────────────────

describe("Custom Fields — MCP parity", () => {
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

	it("list_custom_field_defs returns empty list", async () => {
		const resp = await mcpCall("tools/call", { name: "list_custom_field_defs", arguments: {} });
		expect(resp.error).toBeUndefined();
		const data = JSON.parse(resp.result!.content[0].text) as unknown[];
		expect(Array.isArray(data)).toBe(true);
		expect(data).toHaveLength(0);
	});

	it("create_custom_field_def then list returns it", async () => {
		await mcpCall("tools/call", {
			name: "create_custom_field_def",
			arguments: { key: "effort", label: "Effort", type: "number" },
		});
		const resp = await mcpCall("tools/call", { name: "list_custom_field_defs", arguments: {} });
		const data = JSON.parse(resp.result!.content[0].text) as Array<{ key: string }>;
		expect(data).toHaveLength(1);
		expect(data[0].key).toBe("effort");
	});

	it("delete_custom_field_def via MCP returns ok", async () => {
		const createResp = await mcpCall("tools/call", {
			name: "create_custom_field_def",
			arguments: { key: "tmp", label: "Tmp", type: "text" },
		});
		const created = JSON.parse(createResp.result!.content[0].text) as { id: string };

		const deleteResp = await mcpCall("tools/call", {
			name: "delete_custom_field_def",
			arguments: { id: created.id },
		});
		const deleted = JSON.parse(deleteResp.result!.content[0].text) as { ok: boolean };
		expect(deleted.ok).toBe(true);
	});

	it("list_custom_field_defs appears in tools/list", async () => {
		const resp = await mcpCall("tools/list", {});
		const tools = (resp.result as unknown as { tools: Array<{ name: string }> }).tools;
		const names = tools.map((t) => t.name);
		expect(names).toContain("list_custom_field_defs");
		expect(names).toContain("create_custom_field_def");
		expect(names).toContain("update_custom_field_def");
		expect(names).toContain("delete_custom_field_def");
	});
});

// ─── PROJ-197: batchLoadCustomFields workspace scoping ─────────────────────────

describe("PROJ-197: batchLoadCustomFields is workspace-scoped", () => {
	it("never returns custom field values from another workspace, even for foreign issue IDs", async () => {
		const wsA = await seedFixture({ role: "owner" });
		const wsB = await seedFixture({ role: "owner" });
		const projA = await seedProject(wsA.workspace.id, "AAA");
		const projB = await seedProject(wsB.workspace.id, "BBB");

		const issueA = await seedIssue(wsA.workspace.id, projA.id, wsA.user.id);
		const issueB = await seedIssue(wsB.workspace.id, projB.id, wsB.user.id);

		const defA = await seedCustomFieldDef(wsA.workspace.id, { key: "sev", label: "Severity" });
		const defB = await seedCustomFieldDef(wsB.workspace.id, { key: "sev", label: "Severity" });
		await seedCustomFieldValue(issueA.id, defA.id, "high-A");
		await seedCustomFieldValue(issueB.id, defB.id, "high-B");

		// Pass BOTH issue IDs but scope to workspace A — only A's value may come back.
		const loaded = await batchLoadCustomFields(env.DB, wsA.workspace.id, [issueA.id, issueB.id]);

		expect(loaded[issueA.id]).toHaveLength(1);
		expect(loaded[issueA.id][0].value).toBe("high-A");
		// The foreign workspace's issue must be absent entirely — no cross-tenant leak.
		expect(loaded[issueB.id]).toBeUndefined();
	});

	// Regression: a full 100-issue page bound 100 ids + 1 workspaceId = 101 params,
	// exceeding D1's 100-bound-parameter cap → the query threw and listIssues 500'd
	// (invisible in CI because SQLite allows 32766 params). batchLoadCustomFields now
	// chunks the ids; this proves results still merge correctly across chunk boundaries.
	it("loads values for more issues than the chunk size (spans multiple D1 queries)", async () => {
		const ws = await seedFixture({ role: "owner" });
		const proj = await seedProject(ws.workspace.id, "CHK");
		const def = await seedCustomFieldDef(ws.workspace.id, { key: "sp", label: "Story Points" });

		const COUNT = 95; // > CHUNK_SIZE (90), so ids span two queries
		const issueIds: string[] = [];
		for (let i = 0; i < COUNT; i++) {
			const issue = await seedIssue(ws.workspace.id, proj.id, ws.user.id);
			await seedCustomFieldValue(issue.id, def.id, String(i));
			issueIds.push(issue.id);
		}

		const loaded = await batchLoadCustomFields(env.DB, ws.workspace.id, issueIds);

		expect(Object.keys(loaded)).toHaveLength(COUNT);
		for (let i = 0; i < COUNT; i++) {
			expect(loaded[issueIds[i]]).toHaveLength(1);
			expect(loaded[issueIds[i]][0].value).toBe(String(i));
		}
	});
});
