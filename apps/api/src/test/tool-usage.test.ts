import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitCallEvent, mcpUsageQuery } from "../lib/usage";
import { authHeaders, seedProjectFixture, seedToken } from "./helpers";

type Rpc = { result?: { content?: Array<{ text: string }>; isError?: boolean } };

let token: string;
let slug: string;
let workspaceId: string;
let userId: string;

beforeEach(async () => {
	const fixture = await seedProjectFixture();
	({ token, slug, workspaceId } = fixture);
	userId = fixture.userId;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function rpc(name: string, args: Record<string, unknown>) {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
}

async function call(name: string, args: Record<string, unknown>, bearer = token) {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers: bearer === token ? authHeaders(token, slug) : { Authorization: `Bearer ${bearer}` },
		body: rpc(name, args),
	});
	const json = (await res.json()) as Rpc;
	return { status: res.status, text: json.result?.content?.[0]?.text ?? "" };
}

function captureEvents() {
	const spy = vi.spyOn(console, "log");
	return () =>
		spy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((e): e is Record<string, unknown> => e?.evt === "mcp_call");
}

describe("PROJ-886: one mcp_call event per tools/call", () => {
	it("records a successful call without any argument value", async () => {
		const events = captureEvents();
		const secret = `needle-${crypto.randomUUID()}`;
		await call("search_issues", { query: secret });

		const [evt] = events();
		expect(evt).toMatchObject({
			workspaceId,
			method: "tools/call",
			name: "search_issues",
			outcome: "ok",
			isError: false,
			authMethod: "pat",
			userId,
		});
		expect(evt.responseBytes).toBeGreaterThan(0);
		expect(evt.argBytes).toBeGreaterThan(secret.length);
		expect(JSON.stringify(events())).not.toContain(secret);
	});

	it("records an argument validation failure as outcome=validation", async () => {
		const events = captureEvents();
		await call("get_issue", { ref: 42 });
		expect(events()).toEqual([
			expect.objectContaining({ name: "get_issue", outcome: "validation", isError: true }),
		]);
	});

	it("records a scope denial as outcome=insufficient_scope", async () => {
		const readOnly = await seedToken(workspaceId, userId, { scopes: ["read"] });
		const events = captureEvents();
		const { status } = await call("create_project", { name: "nope", key: "NOPE" }, readOnly);
		expect(status).toBe(403);
		expect(events()).toEqual([
			expect.objectContaining({ name: "create_project", outcome: "insufficient_scope" }),
		]);
	});

	it("writes an Analytics Engine data point indexed by workspace when the binding exists", () => {
		const writeDataPoint = vi.fn();
		const c = {
			env: { MCP_USAGE: { writeDataPoint } },
			req: { query: () => undefined },
			get: (key: string) =>
				key === "auth"
					? { kind: "agent", method: "oauth", credentialId: "grant-1", clientId: "client-1" }
					: key === "user"
						? { id: "u1" }
						: undefined,
		};
		emitCallEvent(c as never, {
			workspaceId: "ws-1",
			method: "tools/call",
			name: "list_issues",
			outcome: "ok",
			isError: false,
			latencyMs: 12,
			responseBytes: 300,
			argBytes: 20,
			version: "1.2.3",
		});
		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ["ws-1"],
			blobs: [
				"list_issues",
				"",
				"full",
				"oauth",
				"grant-1",
				"client-1",
				"u1",
				"ok",
				"1.2.3",
				"tools/call",
			],
			doubles: [12, 300, 20, 0],
		});
	});

	it("never throws into the request when the binding fails", () => {
		const c = {
			env: {
				MCP_USAGE: {
					writeDataPoint: () => {
						throw new Error("boom");
					},
				},
			},
			req: { query: () => undefined },
			get: () => undefined,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() =>
			emitCallEvent(c as never, {
				workspaceId: "ws-1",
				method: "tools/call",
				name: "x",
				outcome: "ok",
				isError: false,
				latencyMs: 0,
				responseBytes: 0,
				argBytes: 0,
				version: "dev",
			})
		).not.toThrow();
	});
});

describe("PROJ-886: get_tool_usage reads Analytics Engine", () => {
	it("reports unavailable (MCP and REST alike) when reading back is not configured", async () => {
		const mcp = JSON.parse((await call("get_tool_usage", {})).text);
		const res = await SELF.fetch("http://localhost/api/tool-usage", {
			headers: authHeaders(token, slug),
		});
		const rest = await res.json();
		expect(mcp.available).toBe(false);
		expect(rest).toEqual(mcp);
	});

	it("queries the SQL API scoped to the workspace and maps the rows", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				data: [{ tool: "list_issues", calls: "3", errors: "1", response_bytes: "900" }],
			})
		);
		vi.stubGlobal("fetch", fetchMock);
		const query = mcpUsageQuery(
			{ CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", MCP_USAGE_DATASET: "mcp_usage" },
			"ws-1"
		);
		const rows = await query?.({ since: 100, until: 200, tool: "list_issues" });

		expect(rows).toEqual([{ tool: "list_issues", calls: 3, errors: 1, responseBytes: 900 }]);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql");
		expect(init.headers).toEqual({ Authorization: "Bearer tok" });
		expect(init.body).toContain("FROM mcp_usage");
		expect(init.body).toContain("index1 = 'ws-1'");
		expect(init.body).toContain("blob1 = 'list_issues'");
		expect(init.body).toContain("toDateTime(100)");
	});

	it("refuses a tool filter that is not a plain identifier without querying", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const query = mcpUsageQuery(
			{ CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", MCP_USAGE_DATASET: "mcp_usage" },
			"ws-1"
		);
		expect(await query?.({ since: 0, until: 1, tool: "x' OR '1'='1" })).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is not configured without all three settings", () => {
		expect(
			mcpUsageQuery({ CF_ACCOUNT_ID: "acct", MCP_USAGE_DATASET: "d" }, "ws-1")
		).toBeUndefined();
	});
});
