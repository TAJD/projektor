// PROJ-1055: every MCP tools/call is counted per workspace, UTC day and tool, and read
// back through get_tool_usage (MCP) and GET /api/tool-usage (REST).

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordToolCall, utcDayStart } from "../services/tool-usage";
import { authHeaders, seedProjectFixture } from "./helpers";

type Rpc = { result?: { content?: Array<{ text: string }>; isError?: boolean } };
type Usage = {
	since: number;
	until: number;
	total: { calls: number; errors: number; responseBytes: number };
	tools: Array<{ tool: string; calls: number; errors: number; responseBytes: number }>;
	omittedTools?: number;
};

let token: string;
let slug: string;
let workspaceId: string;
let projectId: string;

beforeEach(async () => {
	({ token, slug, workspaceId, projectId } = await seedProjectFixture());
});

async function call(name: string, args: Record<string, unknown>) {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	const json = (await res.json()) as Rpc;
	return { isError: json.result?.isError === true, text: json.result?.content?.[0]?.text ?? "" };
}

async function usageRow(tool: string) {
	return env.DB.prepare(
		"SELECT calls, errors, response_bytes FROM mcp_tool_usage WHERE workspace_id = ? AND tool = ?"
	)
		.bind(workspaceId, tool)
		.first<{ calls: number; errors: number; response_bytes: number }>();
}

/** The write runs in waitUntil, after the response; give it a moment to land. */
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
	let v = await read();
	for (let i = 0; i < 50 && !done(v); i++) {
		await new Promise((r) => setTimeout(r, 20));
		v = await read();
	}
	return v;
}

describe("PROJ-1055: recording", () => {
	it("counts a successful call and its response bytes", async () => {
		const { text } = await call("list_projects", {});
		const row = await eventually(
			() => usageRow("list_projects"),
			(r) => (r?.calls ?? 0) >= 1
		);
		expect(row).toEqual({
			calls: 1,
			errors: 0,
			response_bytes: new TextEncoder().encode(text).length,
		});
	});

	it("counts an error result as an error", async () => {
		const { isError } = await call("get_issue", { ref: "PROJ-999" });
		expect(isError).toBe(true);
		const row = await eventually(
			() => usageRow("get_issue"),
			(r) => (r?.calls ?? 0) >= 1
		);
		expect(row?.errors).toBe(1);
	});

	it("upserts into one row per workspace, day and tool", async () => {
		const now = 1_790_000_000;
		await recordToolCall(env.DB, workspaceId, "x", 10, false, now);
		await recordToolCall(env.DB, workspaceId, "x", 5, true, now + 60);
		await recordToolCall(env.DB, workspaceId, "x", 7, false, now + 86_400);
		const { results } = await env.DB.prepare(
			"SELECT day, calls, errors, response_bytes FROM mcp_tool_usage WHERE workspace_id = ? AND tool = 'x' ORDER BY day"
		)
			.bind(workspaceId)
			.all();
		expect(results).toEqual([
			{ day: utcDayStart(now), calls: 2, errors: 1, response_bytes: 15 },
			{ day: utcDayStart(now + 86_400), calls: 1, errors: 0, response_bytes: 7 },
		]);
	});
});

describe("PROJ-1055: get_tool_usage / GET /api/tool-usage", () => {
	beforeEach(async () => {
		const now = Math.floor(Date.now() / 1000);
		await recordToolCall(env.DB, workspaceId, "list_issues", 900, false, now);
		await recordToolCall(env.DB, workspaceId, "list_issues", 100, false, now);
		await recordToolCall(env.DB, workspaceId, "get_issue", 300, true, now);
		// Outside the default 7-day window.
		await recordToolCall(env.DB, workspaceId, "search_wiki", 5000, false, now - 30 * 86_400);
	});

	it("MCP lists tools by bytes with totals over the default window", async () => {
		const { text } = await call("get_tool_usage", {});
		const usage = JSON.parse(text) as Usage;
		const mine = usage.tools.filter((t) => t.tool !== "get_tool_usage");
		expect(mine).toEqual([
			{ tool: "list_issues", calls: 2, errors: 0, responseBytes: 1000, avgResponseBytes: 500 },
			{ tool: "get_issue", calls: 1, errors: 1, responseBytes: 300, avgResponseBytes: 300 },
		]);
	});

	it("REST matches MCP for the same filters", async () => {
		const res = await SELF.fetch(
			"http://localhost/api/tool-usage?tool=list_issues&since=0&until=4102444800",
			{
				headers: authHeaders(token, slug),
			}
		);
		expect(res.status).toBe(200);
		const rest = (await res.json()) as Usage;
		const mcp = JSON.parse(
			(await call("get_tool_usage", { tool: "list_issues", since: 0, until: 4102444800 })).text
		) as Usage;
		expect(rest).toEqual(mcp);
		expect(rest.total).toEqual({ calls: 2, errors: 0, responseBytes: 1000 });
	});

	it("limit trims the list but not the total", async () => {
		const usage = JSON.parse((await call("get_tool_usage", { limit: 1 })).text) as Usage;
		expect(usage.tools).toHaveLength(1);
		expect(usage.omittedTools).toBeGreaterThanOrEqual(1);
		expect(usage.total.responseBytes).toBeGreaterThanOrEqual(1300);
	});

	it("is scoped to the caller's workspace", async () => {
		const other = await seedProjectFixture();
		const res = await SELF.fetch("http://localhost/api/tool-usage", {
			headers: authHeaders(other.token, other.slug),
		});
		const usage = (await res.json()) as Usage;
		expect(usage.tools.map((t) => t.tool)).not.toContain("list_issues");
		expect(usage.total.calls).toBe(0);
		void projectId;
	});

	it("rejects since > until", async () => {
		const res = await SELF.fetch("http://localhost/api/tool-usage?since=200&until=100", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(400);
	});
});
