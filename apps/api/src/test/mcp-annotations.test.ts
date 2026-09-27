// PROJ-887 — MCP tool annotations (readOnlyHint / destructiveHint / idempotentHint /
// openWorldHint) on every core tool, and their presence on the `tools/list` wire
// response.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { capabilityForMcpTool } from "../auth/scopes";
import { DESTRUCTIVE_TOOLS } from "../mcp/annotations";
import { coreMCPTools } from "../routes/mcp";
import { authHeaders, type JsonRpcResult, seedFixture } from "./helpers";

describe("MCP tool annotations (PROJ-887)", () => {
	it("every core tool declares readOnlyHint and openWorldHint", () => {
		const missing = coreMCPTools.filter(
			(t) => t.annotations?.readOnlyHint === undefined || t.annotations?.openWorldHint === undefined
		);
		expect(missing.map((t) => t.name)).toEqual([]);
	});

	it("openWorldHint is false on every core tool", () => {
		const wrong = coreMCPTools.filter((t) => t.annotations?.openWorldHint !== false);
		expect(wrong.map((t) => t.name)).toEqual([]);
	});

	it("every read-capability tool is annotated readOnlyHint: true", () => {
		const wrong = coreMCPTools.filter(
			(t) => capabilityForMcpTool(t.name) === "read" && t.annotations?.readOnlyHint !== true
		);
		expect(wrong.map((t) => t.name)).toEqual([]);
	});

	it("readOnlyHint: true only on read-capability tools (never auto-approve a write)", () => {
		const wrong = coreMCPTools.filter(
			(t) => t.annotations?.readOnlyHint === true && capabilityForMcpTool(t.name) !== "read"
		);
		expect(wrong.map((t) => t.name)).toEqual([]);
	});

	it("update_wiki_page is not claimed idempotent (each save adds a revision)", () => {
		const t = coreMCPTools.find((x) => x.name === "update_wiki_page");
		expect(t?.annotations?.idempotentHint).not.toBe(true);
	});

	it("every non-read (write-capability) tool declares destructiveHint", () => {
		const missing = coreMCPTools.filter(
			(t) =>
				capabilityForMcpTool(t.name) === "write" && t.annotations?.destructiveHint === undefined
		);
		expect(missing.map((t) => t.name)).toEqual([]);
	});

	it("the destructive set matches exactly the 22 tools from the ticket/wiki", () => {
		const actualDestructive = coreMCPTools
			.filter((t) => t.annotations?.destructiveHint === true)
			.map((t) => t.name)
			.sort();
		expect(actualDestructive).toEqual([...DESTRUCTIVE_TOOLS].sort());
		expect(actualDestructive.length).toBe(22);
	});

	it("no non-destructive tool is marked destructiveHint: true, and vice versa", () => {
		const destructiveSet = new Set(DESTRUCTIVE_TOOLS);
		const mismatched = coreMCPTools.filter(
			(t) => Boolean(t.annotations?.destructiveHint) !== destructiveSet.has(t.name)
		);
		expect(mismatched.map((t) => t.name)).toEqual([]);
	});
});

describe("tools/list response carries annotations (PROJ-887)", () => {
	it("returns readOnlyHint/openWorldHint/destructiveHint in the wire payload", async () => {
		const fixture = await seedFixture();
		const headers = authHeaders(fixture.token, fixture.workspace.slug);
		const res = (await SELF.fetch(`http://localhost/mcp/${fixture.workspace.id}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		}).then((r) => r.json())) as JsonRpcResult<{
			tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
		}>;

		const listIssues = res.result.tools.find((t) => t.name === "list_issues");
		expect(listIssues?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

		const deleteIssue = res.result.tools.find((t) => t.name === "delete_issue");
		expect(deleteIssue?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		});

		// Every tool in the wire response must carry annotations at all.
		const missing = res.result.tools.filter((t) => t.annotations === undefined);
		expect(missing.map((t) => t.name)).toEqual([]);
	});
});
