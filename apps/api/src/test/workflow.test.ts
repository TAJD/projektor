import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashWorkflowContent } from "../services/workflow";
import { authHeaders, type JsonRpcError, type JsonRpcResult, seedFixture } from "./helpers";

async function mcpCall<T>(
	workspaceId: string,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return res.json();
}

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

	it("GET /api/workflow returns the spec content plus a version", async () => {
		const res = await SELF.fetch("http://localhost/api/workflow", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			title: string;
			description: string;
			content: string;
			version: string;
		};
		expect(body.title).toBe("Workflow spec");
		expect(body.content).toContain("Definition of ready");
		expect(body.content).toContain("Human gates");
		// PROJ-599: a pointer only, per the spec's own single-home rule.
		expect(body.content).toContain("## Playbooks");
		expect(body.content).toContain('get_playbook("epic-goal")');
		// PROJ-933: a stable content-hash version accompanies the spec.
		expect(typeof body.version).toBe("string");
		expect(body.version.length).toBeGreaterThan(0);
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

	// PROJ-933: version present, stable across requests/processes, and the same on both
	// surfaces.
	it("version is present and stable across repeated requests", async () => {
		const res1 = await SELF.fetch("http://localhost/api/workflow", {
			headers: authHeaders(token, slug),
		});
		const body1 = (await res1.json()) as { version: string };

		const res2 = await SELF.fetch("http://localhost/api/workflow", {
			headers: authHeaders(token, slug),
		});
		const body2 = (await res2.json()) as { version: string };

		expect(body1.version).toBe(body2.version);

		const mcpJson = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "get_workflow", arguments: {} },
			authHeaders(token, slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpBody = JSON.parse(mcpJson.result.content[0].text) as { version: string };
		expect(mcpBody.version).toBe(body1.version);
	});

	it("matching ifVersion over MCP returns only { unchanged: true, version }", async () => {
		const first = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "get_workflow", arguments: {} },
			authHeaders(token, slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const { version } = JSON.parse(first.result.content[0].text) as { version: string };

		const second = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "get_workflow", arguments: { ifVersion: version } },
			authHeaders(token, slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const body = JSON.parse(second.result.content[0].text);

		expect(body).toEqual({ unchanged: true, version });
	});

	it("matching ifVersion over REST returns only { unchanged: true, version }", async () => {
		const first = await SELF.fetch("http://localhost/api/workflow", {
			headers: authHeaders(token, slug),
		});
		const { version } = (await first.json()) as { version: string };

		const second = await SELF.fetch(`http://localhost/api/workflow?ifVersion=${version}`, {
			headers: authHeaders(token, slug),
		});
		expect(second.status).toBe(200);
		const body = await second.json();

		expect(body).toEqual({ unchanged: true, version });
	});

	it("a mismatched ifVersion returns the full content (MCP and REST)", async () => {
		const mcpJson = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "get_workflow", arguments: { ifVersion: "not-the-real-version" } },
			authHeaders(token, slug)
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpBody = JSON.parse(mcpJson.result.content[0].text);
		expect(mcpBody.content).toContain("Definition of ready");
		expect(mcpBody).not.toHaveProperty("unchanged");

		const restRes = await SELF.fetch(
			"http://localhost/api/workflow?ifVersion=not-the-real-version",
			{ headers: authHeaders(token, slug) }
		);
		expect(restRes.status).toBe(200);
		const restBody = (await restRes.json()) as { content: string; unchanged?: boolean };
		expect(restBody.content).toContain("Definition of ready");
		expect(restBody.unchanged).toBeUndefined();
	});

	it("an absent ifVersion returns the full content, not unchanged", async () => {
		const res = await SELF.fetch("http://localhost/api/workflow", {
			headers: authHeaders(token, slug),
		});
		const body = (await res.json()) as { content: string; unchanged?: boolean };
		expect(body.content).toContain("Definition of ready");
		expect(body.unchanged).toBeUndefined();
	});

	it("hashWorkflowContent changes when content changes and is stable for the same content", async () => {
		const a1 = await hashWorkflowContent("some spec content");
		const a2 = await hashWorkflowContent("some spec content");
		const b = await hashWorkflowContent("some different spec content");

		expect(a1).toBe(a2);
		expect(a1).not.toBe(b);
	});

	it("initialize instructions contain the current workflow version", async () => {
		const workflowRes = await SELF.fetch("http://localhost/api/workflow", {
			headers: authHeaders(token, slug),
		});
		const { version } = (await workflowRes.json()) as { version: string };

		const initRes = (await mcpCall(
			workspaceId,
			"initialize",
			{},
			authHeaders(token, slug)
		)) as JsonRpcResult<{ instructions: string }>;

		expect(initRes.result.instructions).toContain(version);
		expect(initRes.result.instructions).toContain("ifVersion");
	});

	it("an invalid ifVersion type over MCP is a -32602 validation error", async () => {
		const res = (await mcpCall(
			workspaceId,
			"tools/call",
			{ name: "get_workflow", arguments: { ifVersion: 42 } },
			authHeaders(token, slug)
		)) as JsonRpcError;

		expect(res.error.code).toBe(-32602);
	});

	it("an invalid ifVersion type over REST (repeated query param) is a 400 validation error", async () => {
		const res = await SELF.fetch("http://localhost/api/workflow?ifVersion=a&ifVersion=b", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(400);
	});
});
