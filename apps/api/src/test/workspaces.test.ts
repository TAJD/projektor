import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	type JsonRpcError,
	type JsonRpcResult,
	seedFixture,
	seedMember,
	seedProject,
	seedToken,
	seedUser,
	seedWorkspace,
} from "./helpers";

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

	// The zero-project path above only proves the guard's count reads 0. This covers the
	// other side of it, which nothing else exercised (PROJ-647 rewrote it to use $count).
	it("delete_workspace refuses while the workspace still has projects", async () => {
		const extra = await seedFixture({ role: "owner" });
		const extraHeaders = authHeaders(extra.token, extra.workspace.slug);
		await seedProject(extra.workspace.id, `P${crypto.randomUUID().slice(0, 6).toUpperCase()}`);

		const res = (await mcpCall(
			extra.workspace.id,
			"delete_workspace",
			{ workspaceSlug: extra.workspace.slug },
			extraHeaders
		)) as JsonRpcError;

		expect(isMcpError(res)).toBe(true);
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

	it("update_workspace renames the workspace (PROJ-246)", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"update_workspace",
			{ name: "Renamed via MCP" },
			userHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;

		expect(isMcpError(res)).toBe(false);
		const data = JSON.parse(res.result.content[0].text) as { ok: boolean };
		expect(data.ok).toBe(true);

		const getRes = await SELF.fetch(`http://localhost/api/workspaces/${slug}`, {
			headers: userHeaders,
		});
		const workspace = (await getRes.json()) as { name: string };
		expect(workspace.name).toBe("Renamed via MCP");
	});

	it("update_workspace returns error for member role (PROJ-246)", async () => {
		const ws = await seedWorkspace(`mcp-update-${crypto.randomUUID().slice(0, 8)}`);
		const memberUser = await import("./helpers").then((h) =>
			h.seedUser(`m-${crypto.randomUUID().slice(0, 8)}@example.com`)
		);
		await seedMember(ws.id, memberUser.id, "member");
		const memberToken = await seedToken(ws.id, memberUser.id);
		const memberHeaders = authHeaders(memberToken, ws.slug);

		const res = (await mcpCall(
			ws.id,
			"update_workspace",
			{ name: "Should Fail" },
			memberHeaders
		)) as JsonRpcError;
		expect(isMcpError(res)).toBe(true);
	});

	it("update_workspace returns error when name missing (PROJ-246)", async () => {
		const res = (await mcpCall(workspaceId, "update_workspace", {}, userHeaders)) as JsonRpcError;
		expect(isMcpError(res)).toBe(true);
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

	it("URL slug mismatched with X-Workspace-Slug header → 404, neither workspace is deleted (PROJ-437)", async () => {
		// ctx.workspaceId (and thus the actual delete target) is resolved from the header,
		// not the URL. Naming a *different* workspace in the URL must not silently delete
		// the header's workspace, nor the URL's.
		const other = await seedWorkspace(`del-437-${crypto.randomUUID().slice(0, 8)}`);
		const res = await SELF.fetch(`http://localhost/api/workspaces/${other.slug}`, {
			method: "DELETE",
			headers: ownerHeaders, // X-Workspace-Slug: slug (the fixture workspace, not `other`)
		});
		expect(res.status).toBe(404);

		const stillThere = await SELF.fetch(`http://localhost/api/workspaces/${slug}`, {
			headers: ownerHeaders,
		});
		expect(stillThere.status).toBe(200);
	});
});

describe("Member removal tombstone (PROJ-436)", () => {
	async function tombstoneRow(workspaceId: string, userId: string) {
		return env.DB.prepare(
			"SELECT removed_at FROM provisioning_removals WHERE workspace_id = ? AND user_id = ?"
		)
			.bind(workspaceId, userId)
			.first<{ removed_at: number }>();
	}

	it("removing a member records a tombstone; re-inviting them clears it", async () => {
		const fixture = await seedFixture({ role: "owner" });
		const memberUser = await seedUser(`m-436-${crypto.randomUUID().slice(0, 8)}@example.com`);
		await seedMember(fixture.workspace.id, memberUser.id, "member");
		const ownerHeaders = authHeaders(fixture.token, fixture.workspace.slug);

		const delRes = await SELF.fetch(
			`http://localhost/api/workspaces/${fixture.workspace.slug}/members/${memberUser.id}`,
			{ method: "DELETE", headers: ownerHeaders }
		);
		expect(delRes.status).toBe(200);
		expect(await tombstoneRow(fixture.workspace.id, memberUser.id)).not.toBeNull();

		const inviteRes = await SELF.fetch(
			`http://localhost/api/workspaces/${fixture.workspace.slug}/members`,
			{
				method: "POST",
				headers: ownerHeaders,
				body: JSON.stringify({ email: memberUser.email, role: "member" }),
			}
		);
		expect(inviteRes.status).toBe(201);
		expect(await tombstoneRow(fixture.workspace.id, memberUser.id)).toBeNull();
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
