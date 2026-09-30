// PROJ-877: malformed JSON and missing params are client errors (400 / JSON-RPC
// -32700/-32600/-32602), never a 500 — and never reach app.onError.

import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authHeaders, seedIssueFixture, toolError } from "./helpers";

let f: Awaited<ReturnType<typeof seedIssueFixture>>;
let unhandled: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	f = await seedIssueFixture({ role: "owner" });
	unhandled = vi.spyOn(console, "error");
});
afterEach(() => {
	const escaped = unhandled.mock.calls.filter((args: unknown[]) => args[0] === "unhandled error");
	expect(escaped).toEqual([]);
	vi.restoreAllMocks();
});

describe("REST: invalid JSON bodies → 400", () => {
	it.each([
		["POST", "/api/issues"],
		["PATCH", "/api/issues/:issueId"],
		["POST", "/api/issues/:issueId/comments"],
		["POST", "/api/projects"],
		["POST", "/api/wiki"],
		["POST", "/api/sprints"],
		["POST", "/api/task-types"],
		["POST", "/api/task-statuses"],
		["POST", "/api/custom-fields"],
		["POST", "/api/issues/:issueId/links"],
		["POST", "/api/agents"],
		["POST", "/api/file-claims"],
		["POST", "/api/agent-messages"],
		// POST /api/workspaces/:slug/tokens needs a human session (PROJ-917); its
		// malformed-body case lives in workspace-tokens.test.ts.
	])("%s %s", async (method, path) => {
		const url = path.replace(":issueId", f.issueId).replace(":slug", f.slug);
		const res = await SELF.fetch(`http://localhost${url}`, {
			method,
			headers: authHeaders(f.token, f.slug),
			body: "{bad json",
		});
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toMatch(/valid JSON/);
	});
});

describe("MCP: parse and envelope errors", () => {
	function mcp(body: string) {
		return SELF.fetch(`http://localhost/mcp/${f.workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
			body,
		});
	}
	const errorCode = async (res: Response) =>
		((await res.json()) as { error?: { code: number } }).error?.code;

	it("invalid JSON → -32700", async () => {
		const res = await mcp("{bad");
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe(-32700);
	});

	it("not a request object → -32600", async () => {
		const res = await mcp("[1,2,3]");
		expect(await errorCode(res)).toBe(-32600);
	});

	it("tools/call with no params → -32602", async () => {
		const res = await mcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }));
		expect(res.status).toBe(200);
		expect(await errorCode(res)).toBe(-32602);
	});

	it("tools/call get_project with no arguments → validation tool error naming the field", async () => {
		const res = await mcp(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "get_project" },
			})
		);
		const body = await res.json();
		const err = toolError(body);
		expect(err?.code).toBe("validation");
		expect(err?.message).toMatch(/Missing required argument/);
	});
});
