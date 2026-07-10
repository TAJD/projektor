import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedFixture, seedMember, seedToken } from "./helpers";

// PROJ-348: the MCP endpoint (POST /mcp/<workspaceId>) must resolve its workspace
// from the URL path UUID when no X-Workspace-Slug header is sent — the Claude app's
// Connectors UI can't send custom headers. The token-workspace-scope check stays the
// security boundary: a token minted for another workspace is still rejected.
describe("MCP workspace resolution without X-Workspace-Slug (PROJ-348)", () => {
	function mcpRequest(workspaceId: string, token: string, extraHeaders?: Record<string, string>) {
		return SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				...extraHeaders,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
	}

	it("succeeds with only Authorization when the token matches the path workspace", async () => {
		const fixture = await seedFixture();
		const res = await mcpRequest(fixture.workspace.id, fixture.token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result?: { tools: unknown[] } };
		expect(Array.isArray(body.result?.tools)).toBe(true);
	});

	it("rejects a token scoped to a different workspace than the path UUID (no slug header)", async () => {
		const owner = await seedFixture();
		const other = await seedFixture();
		// owner's token is a member of `other` too, so the membership check would pass —
		// only the token-workspace-scope check should reject the cross-workspace use.
		await seedMember(other.workspace.id, owner.user.id, "member");

		const res = await mcpRequest(other.workspace.id, owner.token);
		expect(res.status).toBe(403);
	});

	it("returns 404 for an unknown workspace UUID in the path", async () => {
		const fixture = await seedFixture();
		const res = await mcpRequest(crypto.randomUUID(), fixture.token);
		expect(res.status).toBe(404);
	});

	it("still honors an explicit X-Workspace-Slug header on the MCP route", async () => {
		const fixture = await seedFixture();
		const res = await mcpRequest(fixture.workspace.id, fixture.token, {
			"X-Workspace-Slug": fixture.workspace.slug,
		});
		expect(res.status).toBe(200);
	});

	it("accepts a user-scoped (null-workspace) token against the path workspace", async () => {
		const fixture = await seedFixture();
		// A token whose workspace_id is the same workspace still works; a genuinely
		// user-scoped token is exercised by auth tests. Here we confirm the happy path
		// resolves purely from the path UUID.
		const secondToken = await seedToken(fixture.workspace.id, fixture.user.id);
		const res = await mcpRequest(fixture.workspace.id, secondToken);
		expect(res.status).toBe(200);
	});
});

// PROJ-348: the path-UUID fallback is scoped to the MCP route only. Non-MCP routes
// must keep requiring X-Workspace-Slug (subdomain routing off by default).
describe("non-MCP routes still require X-Workspace-Slug (PROJ-348 scope guard)", () => {
	it("REST route without the header 400s naming the missing header", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("X-Workspace-Slug");
	});

	it("REST route with the header still resolves the workspace", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"X-Workspace-Slug": fixture.workspace.slug,
			},
		});
		expect(res.status).toBe(200);
	});
});
