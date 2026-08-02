import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, type JsonRpcResult, seedFixture } from "./helpers";

describe("Workflow spec", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		token = fixture.token;
		slug = fixture.workspace.slug;
		workspaceId = fixture.workspace.id;
	});

	it("GET /api/workflow returns the spec content", async () => {
		const res = await SELF.fetch("http://localhost/api/workflow", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { title: string; description: string; content: string };
		expect(body.title).toBe("Workflow spec");
		expect(body.content).toContain("Definition of ready");
		expect(body.content).toContain("Human gates");
	});

	it("MCP get_workflow returns the same content as REST", async () => {
		const restRes = await SELF.fetch("http://localhost/api/workflow", {
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
				params: { name: "get_workflow", arguments: {} },
			}),
		});
		const mcpJson = (await mcpRes.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpBody = JSON.parse(mcpJson.result.content[0].text);

		expect(mcpBody).toEqual(restBody);
	});
});
