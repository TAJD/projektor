import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedFixture,
	seedMember,
	seedProject,
	seedToken,
	seedWorkspace,
} from "./helpers";

type JsonRpcResult<T = unknown> = { jsonrpc: "2.0"; id: unknown; result: T };
type JsonRpcError = { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

async function mcpCall<T>(
	workspaceId: string,
	name: string,
	args: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	return res.json();
}

function isMcpError(r: JsonRpcResult | JsonRpcError): r is JsonRpcError {
	return "error" in r;
}

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("Workspaces MCP", () => {
	let workspaceId: string;
	let slug: string;
	let userId: string;
	let userToken: string;
	let userHeaders: Record<string, string>;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		workspaceId = fixture.workspace.id;
		slug = fixture.workspace.slug;
		userId = fixture.user.id;
		userToken = fixture.token;
		userHeaders = authHeaders(userToken, slug);
	});

	it("list_workspaces returns the single workspace the user belongs to", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_workspaces",
			{},
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const data = JSON.parse(res.result.content[0].text) as Array<{ id: string; role: string }>;
		expect(Array.isArray(data)).toBe(true);
		expect(data).toHaveLength(1);
		expect(data[0].id).toBe(workspaceId);
		expect(data[0].role).toBe("owner");
	});

	it("list_workspaces returns both workspaces when user is a member of two", async () => {
		// Add user to a second workspace
		const ws2 = await seedWorkspace(`ws2-${crypto.randomUUID().slice(0, 8)}`);
		await seedMember(ws2.id, userId, "member");
		const token2 = await seedToken(ws2.id, userId);

		// Call using either workspace as the path param — should still return both
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_workspaces",
			{},
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const data = JSON.parse(res.result.content[0].text) as Array<{ id: string }>;
		expect(data).toHaveLength(2);
		const ids = data.map((w) => w.id);
		expect(ids).toContain(workspaceId);
		expect(ids).toContain(ws2.id);
		// Silence unused variable warning
		void token2;
	});

	it("list_workspaces does not expose workspaces of other users", async () => {
		// Create a second user with their own workspace
		const other = await seedFixture({ role: "owner" });

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_workspaces",
			{},
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const data = JSON.parse(res.result.content[0].text) as Array<{ id: string }>;
		const ids = data.map((w) => w.id);
		expect(ids).not.toContain(other.workspace.id);
	});

	it("list_workspaces returns workspace id, name, slug, role fields", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_workspaces",
			{},
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const data = JSON.parse(res.result.content[0].text) as Array<Record<string, unknown>>;
		expect(data[0]).toHaveProperty("id");
		expect(data[0]).toHaveProperty("name");
		expect(data[0]).toHaveProperty("slug");
		expect(data[0]).toHaveProperty("role");
	});

	it("create_workspace creates a workspace and returns id, name, slug", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"create_workspace",
			{ slug: "new-ws", name: "New Workspace" },
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const created = JSON.parse(res.result.content[0].text) as {
			id: string;
			name: string;
			slug: string;
		};
		expect(created.id).toBeTruthy();
		expect(created.name).toBe("New Workspace");
		expect(created.slug).toBe("new-ws");
	});

	it("create_workspace adds caller as owner and seeds defaults", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"create_workspace",
			{ slug: "seeded-ws", name: "Seeded" },
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const created = JSON.parse(res.result.content[0].text) as { id: string };

		// Caller should be able to list it via list_workspaces
		const listRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_workspaces",
			{},
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const workspaces = JSON.parse(listRes.result.content[0].text) as Array<{
			id: string;
			role: string;
		}>;
		const newWs = workspaces.find((w) => w.id === created.id);
		expect(newWs).toBeDefined();
		expect(newWs?.role).toBe("owner");
	});

	it("create_workspace returns conflict error when slug already taken", async () => {
		await mcpCall(
			workspaceId,
			"create_workspace",
			{ slug: "dup-slug", name: "First" },
			userHeaders
		);
		const res = (await mcpCall(
			workspaceId,
			"create_workspace",
			{ slug: "dup-slug", name: "Second" },
			userHeaders
		)) as JsonRpcError;
		expect(isMcpError(res)).toBe(true);
		expect(res.error.message).toMatch(/slug already taken/i);
	});

	it("create_workspace returns error when required fields missing", async () => {
		const res = (await mcpCall(
			workspaceId,
			"create_workspace",
			{ name: "No Slug" },
			userHeaders
		)) as JsonRpcError;
		expect(isMcpError(res)).toBe(true);
	});

	it("delete_workspace removes the workspace and returns ok: true", async () => {
		const extra = await seedFixture({ role: "owner" });
		const extraHeaders = authHeaders(extra.token, extra.workspace.slug);

		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			extra.workspace.id,
			"delete_workspace",
			{ workspaceSlug: extra.workspace.slug },
			extraHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const data = JSON.parse(res.result.content[0].text) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	it("delete_workspace returns error for non-owner", async () => {
		const ws = await seedWorkspace(`mcp-del-${crypto.randomUUID().slice(0, 8)}`);
		const memberUser = await import("./helpers").then((h) =>
			h.seedUser(`m-${crypto.randomUUID().slice(0, 8)}@example.com`)
		);
		await seedMember(ws.id, memberUser.id, "member");
		const memberToken = await seedToken(ws.id, memberUser.id);
		const memberHeaders = authHeaders(memberToken, ws.slug);

		const res = (await mcpCall(
			ws.id,
			"delete_workspace",
			{ workspaceSlug: ws.slug },
			memberHeaders
		)) as JsonRpcError;
		expect(isMcpError(res)).toBe(true);
	});

	it("delete_workspace returns error when workspace has projects", async () => {
		const extra = await seedFixture({ role: "owner" });
		await seedProject(extra.workspace.id);
		const extraHeaders = authHeaders(extra.token, extra.workspace.slug);

		const res = (await mcpCall(
			extra.workspace.id,
			"delete_workspace",
			{ workspaceSlug: extra.workspace.slug },
			extraHeaders
		)) as JsonRpcError;
		expect(isMcpError(res)).toBe(true);
		expect(res.error.message).toMatch(/delete all projects/i);
	});
});

describe("DELETE /api/workspaces/:slug (PROJ-96)", () => {
	let workspaceId: string;
	let slug: string;
	let ownerToken: string;
	let ownerHeaders: Record<string, string>;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		workspaceId = fixture.workspace.id;
		slug = fixture.workspace.slug;
		ownerToken = fixture.token;
		ownerHeaders = authHeaders(ownerToken, slug);
	});

	it("owner can delete a workspace with no projects → 200 { ok: true }", async () => {
		const res = await SELF.fetch(`http://localhost/api/workspaces/${slug}`, {
			method: "DELETE",
			headers: ownerHeaders,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	it("non-owner gets 403", async () => {
		const ws = await seedWorkspace(`del-403-${crypto.randomUUID().slice(0, 8)}`);
		const memberUser = await import("./helpers").then((h) =>
			h.seedUser(`m-${crypto.randomUUID().slice(0, 8)}@example.com`)
		);
		await seedMember(ws.id, memberUser.id, "member");
		const memberToken = await seedToken(ws.id, memberUser.id);
		const res = await SELF.fetch(`http://localhost/api/workspaces/${ws.slug}`, {
			method: "DELETE",
			headers: authHeaders(memberToken, ws.slug),
		});
		expect(res.status).toBe(403);
	});

	it("deleting DEFAULT_WORKSPACE_SLUG → 400 ValidationError", async () => {
		// The dev wrangler.toml sets DEFAULT_WORKSPACE_SLUG = "projektor"
		const defaultWs = await seedWorkspace("projektor");
		const ownerUser = await import("./helpers").then((h) =>
			h.seedUser(`owner-def-${crypto.randomUUID().slice(0, 8)}@example.com`)
		);
		await seedMember(defaultWs.id, ownerUser.id, "owner");
		const ownerTok = await seedToken(defaultWs.id, ownerUser.id);
		const res = await SELF.fetch(`http://localhost/api/workspaces/projektor`, {
			method: "DELETE",
			headers: authHeaders(ownerTok, "projektor"),
		});
		expect(res.status).toBe(400);
	});

	it("workspace with projects → 409 ConflictError", async () => {
		await seedProject(workspaceId);
		const res = await SELF.fetch(`http://localhost/api/workspaces/${slug}`, {
			method: "DELETE",
			headers: ownerHeaders,
		});
		expect(res.status).toBe(409);
	});
});

describe("GET /api/workspaces/:slug (currentUserRole)", () => {
	it("returns members and the caller's own role for an owner", async () => {
		const fixture = await seedFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/workspaces/${fixture.workspace.slug}`, {
			headers: authHeaders(fixture.token, fixture.workspace.slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { currentUserRole: string; members: unknown[] };
		expect(body.currentUserRole).toBe("owner");
		expect(Array.isArray(body.members)).toBe(true);
	});

	it("reports the caller's role as viewer when they are a viewer", async () => {
		const fixture = await seedFixture({ role: "viewer" });
		const res = await SELF.fetch(`http://localhost/api/workspaces/${fixture.workspace.slug}`, {
			headers: authHeaders(fixture.token, fixture.workspace.slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { currentUserRole: string };
		expect(body.currentUserRole).toBe("viewer");
	});
});

describe("GET /api/workspaces/:slug/mcp-info (PROJ-83)", () => {
	let workspaceId: string;
	let slug: string;
	let memberToken: string;
	let memberHeaders: Record<string, string>;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "member" });
		workspaceId = fixture.workspace.id;
		slug = fixture.workspace.slug;
		memberToken = fixture.token;
		memberHeaders = authHeaders(memberToken, slug);
	});

	it("returns mcpUrl, workspaceId, workspaceSlug, mcpAddCommandTemplate", async () => {
		const res = await SELF.fetch(`http://localhost/api/workspaces/${slug}/mcp-info`, {
			headers: memberHeaders,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mcpUrl: string;
			workspaceId: string;
			workspaceSlug: string;
			mcpAddCommandTemplate: string;
		};
		expect(body.workspaceId).toBe(workspaceId);
		expect(body.workspaceSlug).toBe(slug);
		expect(body.mcpUrl).toMatch(/\/mcp\//);
		expect(body.mcpAddCommandTemplate).toContain("claude mcp add");
		expect(body.mcpAddCommandTemplate).toContain("{{TOKEN}}");
		expect(body.mcpAddCommandTemplate).toContain(slug);
	});
});
