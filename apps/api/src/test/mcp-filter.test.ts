import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TOOL_COUNT, TOOL_DOMAIN_SLUGS } from "../mcp/catalog";
import { authHeaders, type JsonRpcError, type JsonRpcResult, seedFixture } from "./helpers";

async function mcpFetch(
	workspaceId: string,
	method: string,
	params: unknown,
	headers: Record<string, string>,
	query = ""
): Promise<Response> {
	return SELF.fetch(`http://localhost/mcp/${workspaceId}${query}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
}

async function mcpCall<T>(
	workspaceId: string,
	method: string,
	params: unknown,
	headers: Record<string, string>,
	query = ""
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await mcpFetch(workspaceId, method, params, headers, query);
	return res.json();
}

describe("MCP tools/list domain filtering (PROJ-716)", () => {
	let workspaceId: string;
	let headers: Record<string, string>;

	beforeEach(async () => {
		const fixture = await seedFixture();
		workspaceId = fixture.workspace.id;
		headers = authHeaders(fixture.token, fixture.workspace.slug);
	});

	it("no domains param returns the full unfiltered catalog", async () => {
		const res = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		expect(res.result.tools.length).toBe(TOOL_COUNT);
	});

	it("filters to the requested domain's tools only", async () => {
		const res = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=issues"
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		const names = res.result.tools.map((t) => t.name);
		expect(names).toContain("get_issue");
		expect(names).toContain("list_issues");
		expect(names).not.toContain("get_wiki_page");
		expect(names.length).toBeLessThan(TOOL_COUNT);
	});

	it("unions tools across multiple requested domains", async () => {
		const res = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=issues,wiki"
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		const names = res.result.tools.map((t) => t.name);
		expect(names).toContain("get_issue");
		expect(names).toContain("get_wiki_page");
	});

	it("dedupes repeated slugs and ignores order", async () => {
		const dupRes = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=issues,issues,issues"
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		const straightRes = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=issues"
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		expect(dupRes.result.tools.map((t) => t.name).sort()).toEqual(
			straightRes.result.tools.map((t) => t.name).sort()
		);

		const forwardRes = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=issues,wiki"
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		const reversedRes = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=wiki,issues"
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		expect(forwardRes.result.tools.map((t) => t.name).sort()).toEqual(
			reversedRes.result.tools.map((t) => t.name).sort()
		);
	});

	it("unknown domain slug returns 400 naming valid domains, never a silent full catalog", async () => {
		const res = await mcpFetch(workspaceId, "tools/list", {}, headers, "?domains=not-a-domain");
		expect(res.status).toBe(400);
		const body = (await res.json()) as JsonRpcError;
		expect(body.error.message).toContain("not-a-domain");
		for (const slug of TOOL_DOMAIN_SLUGS) {
			expect(body.error.message).toContain(slug);
		}
	});

	it("one unknown slug among valid ones still 400s (fail closed)", async () => {
		const res = await mcpFetch(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=issues,bogus-domain"
		);
		expect(res.status).toBe(400);
	});

	it("blank domains param behaves like no filter", async () => {
		const res = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains="
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		expect(res.result.tools.length).toBe(TOOL_COUNT);
	});

	it("tools/call still serves a tool that was filtered out of the listing", async () => {
		const listRes = (await mcpCall<{ tools: Array<{ name: string }> }>(
			workspaceId,
			"tools/list",
			{},
			headers,
			"?domains=issues"
		)) as JsonRpcResult<{ tools: Array<{ name: string }> }>;
		expect(listRes.result.tools.map((t) => t.name)).not.toContain("get_wiki_page");

		const callRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"tools/call",
			{ name: "search_wiki", arguments: { query: "" } },
			headers,
			"?domains=issues"
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		expect(callRes.result.content[0].text).toBeDefined();
	});
});
