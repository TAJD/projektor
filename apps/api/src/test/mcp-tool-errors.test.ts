// PROJ-893: a failed tools/call is a tool *result* (`isError: true`) with a code and a
// next-step hint, so the model can self-correct. JSON-RPC errors are reserved for protocol
// faults; scope denials stay an HTTP 403 with a WWW-Authenticate challenge (PROJ-651).

import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	seedIssueFixture,
	seedProjectFixture,
	seedToken,
	type ToolErrorBody,
	toolError,
} from "./helpers";

type Rpc = {
	error?: { code: number; message: string };
	result?: { isError?: boolean; content?: Array<{ text: string }> };
};

describe("PROJ-893: MCP tool failures are isError results", () => {
	// This suite makes more calls per token than wrangler.test.toml's RATE_LIMIT_API_MAX.
	const prevApiMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "1000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevApiMax;
	});

	let f: Awaited<ReturnType<typeof seedIssueFixture>>;
	beforeEach(async () => {
		f = await seedIssueFixture({ role: "owner" });
	});

	async function post(body: unknown, token = f.token): Promise<Response> {
		return SELF.fetch(`http://localhost/mcp/${f.workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	}

	async function call(name: string, args: unknown, token = f.token): Promise<Rpc> {
		const res = await post(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
			token
		);
		expect(res.status).toBe(200);
		return (await res.json()) as Rpc;
	}

	/** Asserts the failure is a tool result (not a JSON-RPC error) and returns its body. */
	async function failure(name: string, args: unknown, token = f.token): Promise<ToolErrorBody> {
		const res = await call(name, args, token);
		expect(res.error, "must not be a JSON-RPC error").toBeUndefined();
		expect(res.result?.isError).toBe(true);
		const body = toolError(res);
		expect(body).toBeDefined();
		return body as ToolErrorBody;
	}

	it("not_found on an issue ref: code, message, and a hint naming the ref format and search_issues", async () => {
		const e = await failure("get_issue", { ref: "PROJ-99999" });
		expect(e.code).toBe("not_found");
		expect(e.message).toMatch(/not found/i);
		expect(e.hint).toContain("PROJ-42");
		expect(e.hint).toContain("search_issues");
	});

	it("not_found on a wiki slug: the hint points at search_wiki", async () => {
		const e = await failure("get_wiki_page", { slug: "no-such-page" });
		expect(e.code).toBe("not_found");
		expect(e.hint).toContain("search_wiki");
	});

	it("not_found on an unknown agent session hints at register_agent, not at issue refs", async () => {
		const e = await failure("heartbeat_agent", { id: crypto.randomUUID() });
		expect(e.code).toBe("not_found");
		expect(e.hint).toContain("register_agent");
	});

	it("validation: the offending fields are named in `fields` and in the hint", async () => {
		const e = await failure("create_wiki_page", { title: "", content: "x" });
		expect(e.code).toBe("validation");
		expect(Object.keys(e.fields ?? {})).toContain("title");
		expect(e.hint).toContain("title");
	});

	it("validation: a missing required argument is named", async () => {
		const e = await failure("get_project", {});
		expect(e.code).toBe("validation");
		expect(e.message).toMatch(/Missing required argument/);
		expect(e.fields).toBeDefined();
		expect(e.hint).toMatch(/^Fix /);
	});

	it("validation: a wrongly-typed argument is caught before the handler runs", async () => {
		const e = await failure("get_issue", { ref: 42 });
		expect(e.code).toBe("validation");
		expect(Object.keys(e.fields ?? {})).toContain("ref");
	});

	it("forbidden: the hint says what role is needed", async () => {
		const viewer = await seedProjectFixture({ role: "viewer" });
		const res = await SELF.fetch(`http://localhost/mcp/${viewer.workspaceId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create_project", arguments: { name: "Nope", key: "NOPE" } },
			}),
		});
		const body = (await res.json()) as Rpc;
		expect(body.error).toBeUndefined();
		const e = toolError(body);
		expect(e?.code).toBe("forbidden");
		expect(e?.hint).toContain("viewer");
	});

	it("conflict on a stale wiki save: re-read, then patch_wiki_page — and the current revision is in details", async () => {
		const created = JSON.parse(
			(await call("create_wiki_page", { title: "Locked Doc", content: "v1" })).result?.content?.[0]
				.text ?? "{}"
		) as { slug: string };
		await call("update_wiki_page", { slug: created.slug, content: "v2" });
		const revisions = JSON.parse(
			(await call("list_wiki_revisions", { slug: created.slug })).result?.content?.[0].text ?? "[]"
		) as Array<{ id: string }>;
		const stale = revisions[0].id;
		await call("update_wiki_page", { slug: created.slug, content: "v3", baseRevisionId: stale });

		const e = await failure("update_wiki_page", {
			slug: created.slug,
			content: "v4",
			baseRevisionId: stale,
		});
		expect(e.code).toBe("conflict");
		expect(e.hint).toContain("get_wiki_page");
		expect(e.hint).toContain("patch_wiki_page");
		expect(e.details?.currentRevisionId).toBeTypeOf("string");
	});

	it("a successful call is not flagged", async () => {
		const res = await call("get_issue", { ref: `PROJ-1` });
		expect(res.error).toBeUndefined();
		expect(res.result?.isError).toBeUndefined();
	});

	describe("JSON-RPC errors stay reserved for protocol faults", () => {
		it("an unknown tool is a -32601 protocol error, not an isError result", async () => {
			const res = await call("no_such_tool", {});
			expect(res.error?.code).toBe(-32601);
			expect(res.result).toBeUndefined();
		});

		it("an unknown method is -32601", async () => {
			const res = (await (
				await post({ jsonrpc: "2.0", id: 1, method: "nope/nope" })
			).json()) as Rpc;
			expect(res.error?.code).toBe(-32601);
		});

		it("malformed JSON is a -32700 parse error", async () => {
			const res = await post("{ not json");
			expect(res.status).toBe(400);
			expect(((await res.json()) as Rpc).error?.code).toBe(-32700);
		});

		it("a body that is not a request object is a -32600 invalid request", async () => {
			const res = await post([1, 2, 3]);
			expect(res.status).toBe(400);
			expect(((await res.json()) as Rpc).error?.code).toBe(-32600);
		});

		it("a tools/call with no tool name is a -32602 invalid-params protocol error", async () => {
			const res = (await (
				await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })
			).json()) as Rpc;
			expect(res.error?.code).toBe(-32602);
		});
	});

	it("a scope denial stays an HTTP 403 with a WWW-Authenticate challenge", async () => {
		const readOnly = await seedToken(f.workspaceId, f.userId, { scopes: ["read"] });
		const res = await post(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create_issue", arguments: { projectId: f.projectId, title: "x" } },
			},
			readOnly
		);
		expect(res.status).toBe(403);
		expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
		const body = (await res.json()) as Rpc;
		expect(body.error?.code).toBe(-32003);
		expect(body.result).toBeUndefined();
	});
});
