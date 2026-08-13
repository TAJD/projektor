import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, type JsonRpcResult, seedFixture } from "./helpers";

describe("Playbooks", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	it("GET /api/playbooks lists the registry", async () => {
		const res = await SELF.fetch("http://localhost/api/playbooks", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ name: string; title: string }>;
		expect(body.find((p) => p.name === "epic-goal")).toBeTruthy();
	});

	// PROJ-633: the playbook reads are deliberately global — no workspace. Adding the
	// compose route required workspace context, and applying workspaceMiddleware to the
	// whole /api/playbooks prefix to get it would make these two 400 without a slug.
	// Every other test here sends one, so only this asserts the prefix stays global.
	it("GET /api/playbooks and /:name work without an X-Workspace-Slug header", async () => {
		const auth = { Authorization: `Bearer ${token}` };

		const list = await SELF.fetch("http://localhost/api/playbooks", { headers: auth });
		expect(list.status).toBe(200);

		const one = await SELF.fetch("http://localhost/api/playbooks/epic-goal", { headers: auth });
		expect(one.status).toBe(200);
	});

	it("MCP list_playbooks returns the same content as REST", async () => {
		const restRes = await SELF.fetch("http://localhost/api/playbooks", {
			headers: authHeaders(token, slug),
		});
		const restBody = await restRes.json();

		const mcpRes = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_playbooks", arguments: {} },
			}),
		});
		const mcpJson = (await mcpRes.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpBody = JSON.parse(mcpJson.result.content[0].text);

		expect(mcpBody).toEqual(restBody);
	});

	it("GET /api/playbooks/:name returns the full playbook", async () => {
		const res = await SELF.fetch("http://localhost/api/playbooks/epic-goal", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string; content: string };
		expect(body.name).toBe("epic-goal");
		expect(body.content).toContain("bounded variant");
		expect(body.content).toContain("full variant");
		expect(body.content).toContain("Audit first");
	});

	it("MCP get_playbook returns the same content as REST", async () => {
		const restRes = await SELF.fetch("http://localhost/api/playbooks/epic-goal", {
			headers: authHeaders(token, slug),
		});
		const restBody = await restRes.json();

		const mcpRes = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_playbook", arguments: { name: "epic-goal" } },
			}),
		});
		const mcpJson = (await mcpRes.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpBody = JSON.parse(mcpJson.result.content[0].text);

		expect(mcpBody).toEqual(restBody);
	});

	it("GET /api/playbooks/:name 404s on an unknown name", async () => {
		const res = await SELF.fetch("http://localhost/api/playbooks/does-not-exist", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; validNames: string[] };
		expect(body.error).toContain("does-not-exist");
		expect(body.validNames).toContain("epic-goal");
	});

	it("MCP get_playbook errors on an unknown name, naming valid options", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_playbook", arguments: { name: "does-not-exist" } },
			}),
		});
		const json = (await res.json()) as {
			error: { message: string; data?: { validNames: string[] } };
		};
		expect(json.error.message).toContain("does-not-exist");
		expect(json.error.data?.validNames).toContain("epic-goal");
	});
});
