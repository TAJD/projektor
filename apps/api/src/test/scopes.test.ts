/**
 * PROJ-17 — API-token scope enforcement.
 *
 * Covers:
 *  - the pure scope helpers (auth/scopes.ts),
 *  - REST enforcement (read token blocked from writes, write/`*` allowed),
 *  - MCP per-tool enforcement (read token blocked from write tools),
 *  - scope validation + membership check at token creation (/auth/tokens).
 */

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	capabilityForMcpTool,
	capabilityForMethod,
	capabilityForOAuthScope,
	OAUTH_SCOPES_SUPPORTED,
	parseScopes,
	tokenAllows,
} from "../auth/scopes";
import {
	authHeaders,
	type JsonRpcError,
	type JsonRpcResult,
	seedProject,
	seedToken,
	seedUser,
	seedWorkspace,
} from "./helpers";

/** Seed a workspace + owner + a project in it, for scope-enforcement tests. */
async function seedScopeFixture() {
	const ws = await seedWorkspace(`ws-${crypto.randomUUID().slice(0, 8)}`);
	const user = await seedUser(`u-${crypto.randomUUID().slice(0, 8)}@example.com`);
	await env.DB.prepare(
		"INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)"
	)
		.bind(ws.id, user.id, Math.floor(Date.now() / 1000))
		.run();
	const project = await seedProject(ws.id);
	return { slug: ws.slug, workspaceId: ws.id, userId: user.id, projectId: project.id };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("PROJ-17: scope helpers", () => {
	it("tokenAllows: '*' grants everything", () => {
		expect(tokenAllows(["*"], "read")).toBe(true);
		expect(tokenAllows(["*"], "write")).toBe(true);
	});

	it("tokenAllows: 'write' implies 'read'", () => {
		expect(tokenAllows(["write"], "write")).toBe(true);
		expect(tokenAllows(["write"], "read")).toBe(true);
	});

	it("tokenAllows: 'read' permits reads only", () => {
		expect(tokenAllows(["read"], "read")).toBe(true);
		expect(tokenAllows(["read"], "write")).toBe(false);
	});

	it("tokenAllows: unknown/empty scopes grant nothing (fail-closed)", () => {
		expect(tokenAllows([], "read")).toBe(false);
		expect(tokenAllows(["bogus"], "read")).toBe(false);
		expect(tokenAllows(["bogus"], "write")).toBe(false);
	});

	it("capabilityForMethod: safe methods read, others write", () => {
		expect(capabilityForMethod("GET")).toBe("read");
		expect(capabilityForMethod("HEAD")).toBe("read");
		expect(capabilityForMethod("POST")).toBe("write");
		expect(capabilityForMethod("patch")).toBe("write");
		expect(capabilityForMethod("DELETE")).toBe("write");
	});

	it("capabilityForMcpTool: list/get/search/wiki_tree read, rest write", () => {
		expect(capabilityForMcpTool("list_issues")).toBe("read");
		expect(capabilityForMcpTool("get_prioritized_issues")).toBe("read");
		expect(capabilityForMcpTool("search_wiki")).toBe("read");
		expect(capabilityForMcpTool("wiki_tree")).toBe("read");
		expect(capabilityForMcpTool("create_issue")).toBe("write");
		expect(capabilityForMcpTool("add_comment")).toBe("write");
		expect(capabilityForMcpTool("delete_wiki_page")).toBe("write");
	});

	it("parseScopes: parses JSON arrays, fails closed on garbage", () => {
		expect(parseScopes('["read","write"]')).toEqual(["read", "write"]);
		expect(parseScopes(null)).toEqual([]);
		expect(parseScopes("not json")).toEqual([]);
		expect(parseScopes('{"a":1}')).toEqual([]);
		expect(parseScopes('["read",2,null]')).toEqual(["read"]);
	});

	it("parseScopes: accepts the legacy unquoted bracketed format", () => {
		// Some early tokens stored "[read,write]" (not valid JSON) — must still work.
		expect(parseScopes("[read,write]")).toEqual(["read", "write"]);
		expect(parseScopes("[ read , write ]")).toEqual(["read", "write"]);
		expect(parseScopes("[]")).toEqual([]);
		// Round-trips through tokenAllows as a real write-capable token.
		expect(tokenAllows(parseScopes("[read,write]"), "write")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// REST enforcement
// ---------------------------------------------------------------------------

describe("PROJ-17: REST scope enforcement", () => {
	let slug: string;
	let projectId: string;
	let userId: string;
	let workspaceId: string;

	beforeEach(async () => {
		({ slug, workspaceId, userId, projectId } = await seedScopeFixture());
	});

	it("read-only token can GET but not POST", async () => {
		const token = await seedToken(workspaceId, userId, { scopes: ["read"] });
		const headers = authHeaders(token, slug);

		const getRes = await SELF.fetch("http://localhost/api/issues", { headers });
		expect(getRes.status).toBe(200);

		const postRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers,
			body: JSON.stringify({ projectId, title: "should be blocked" }),
		});
		expect(postRes.status).toBe(403);
		expect(await postRes.json()).toMatchObject({ error: expect.stringContaining("write") });
	});

	it("write token can POST", async () => {
		const token = await seedToken(workspaceId, userId, { scopes: ["write"] });
		const res = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ projectId, title: "written by write token" }),
		});
		expect(res.status).toBe(201);
	});

	it("wildcard token can both read and write", async () => {
		const token = await seedToken(workspaceId, userId, { scopes: ["*"] });
		const headers = authHeaders(token, slug);

		expect((await SELF.fetch("http://localhost/api/issues", { headers })).status).toBe(200);
		const postRes = await SELF.fetch("http://localhost/api/issues", {
			method: "POST",
			headers,
			body: JSON.stringify({ projectId, title: "written by wildcard token" }),
		});
		expect(postRes.status).toBe(201);
	});

	it("read token is blocked from DELETE", async () => {
		const token = await seedToken(workspaceId, userId, { scopes: ["read"] });
		const res = await SELF.fetch(`http://localhost/api/issues/${crypto.randomUUID()}`, {
			method: "DELETE",
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(403);
	});
});

// ---------------------------------------------------------------------------
// MCP enforcement
// ---------------------------------------------------------------------------

async function mcpCall(
	workspaceId: string,
	name: string,
	args: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	return res.json();
}

function isMcpError(r: JsonRpcResult | JsonRpcError): r is JsonRpcError {
	return "error" in r;
}

describe("PROJ-17: MCP scope enforcement", () => {
	let slug: string;
	let projectId: string;
	let userId: string;
	let workspaceId: string;

	beforeEach(async () => {
		({ slug, workspaceId, userId, projectId } = await seedScopeFixture());
	});

	it("read token: read tool works, write tool is blocked", async () => {
		const token = await seedToken(workspaceId, userId, { scopes: ["read"] });
		const headers = authHeaders(token, slug);

		const listed = await mcpCall(workspaceId, "list_issues", {}, headers);
		expect(isMcpError(listed)).toBe(false);

		const created = await mcpCall(
			workspaceId,
			"create_issue",
			{ projectId, title: "blocked" },
			headers
		);
		expect(isMcpError(created)).toBe(true);
		if (isMcpError(created)) {
			expect(created.error.code).toBe(-32003);
			expect(created.error.message).toContain("write");
		}
	});

	it("write token: write tool works", async () => {
		const token = await seedToken(workspaceId, userId, { scopes: ["write"] });
		const created = await mcpCall(
			workspaceId,
			"create_issue",
			{ projectId, title: "made via mcp" },
			authHeaders(token, slug)
		);
		expect(isMcpError(created)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Token creation: scope validation + membership (POST /auth/tokens)
// ---------------------------------------------------------------------------

describe("PROJ-17: POST /auth/tokens", () => {
	let workspaceId: string;
	let userId: string;
	let callerToken: string;

	beforeEach(async () => {
		const ws = await seedWorkspace(`ws-${crypto.randomUUID().slice(0, 8)}`);
		workspaceId = ws.id;
		const user = await seedUser(`u-${crypto.randomUUID().slice(0, 8)}@example.com`);
		userId = user.id;
		await env.DB.prepare(
			"INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)"
		)
			.bind(workspaceId, userId, Math.floor(Date.now() / 1000))
			.run();
		// The caller authenticates with a full-access token (creating a token is a write).
		callerToken = await seedToken(workspaceId, userId, { scopes: ["*"] });
	});

	it("a member can mint a token for their workspace", async () => {
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: { Authorization: `Bearer ${callerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "mine", workspaceId, scopes: ["read"] }),
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ token: expect.any(String) });
	});

	it("minting a token for a workspace you don't belong to is forbidden", async () => {
		const other = await seedWorkspace(`ws-${crypto.randomUUID().slice(0, 8)}`);
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: { Authorization: `Bearer ${callerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "sneaky", workspaceId: other.id, scopes: ["*"] }),
		});
		expect(res.status).toBe(403);
	});

	it("rejects invalid scope values", async () => {
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: { Authorization: `Bearer ${callerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "bad", workspaceId, scopes: ["admin"] }),
		});
		expect(res.status).toBe(400);
	});
});

// PROJ-655: the OAuth wire names are a public contract — they ship in
// `scopes_supported` on the discovery documents, which Claude caches globally by
// URL across every user of an instance. Pinning them in a test makes a rename a
// deliberate act rather than a refactor's collateral damage.
describe("OAuth wire scope names (PROJ-655)", () => {
	it("advertises exactly the two namespaced scopes", () => {
		expect([...OAUTH_SCOPES_SUPPORTED]).toEqual(["projektor:read", "projektor:write"]);
	});

	it("maps each wire scope to the capability it grants", () => {
		expect(capabilityForOAuthScope("projektor:read")).toBe("read");
		expect(capabilityForOAuthScope("projektor:write")).toBe("write");
	});

	it("fails closed on a scope it does not issue", () => {
		// Notably the bare internal names: they are NOT valid on the wire, so a
		// client that guesses them gets nothing rather than accidental read access.
		for (const scope of ["read", "write", "*", "offline_access", "projektor:admin", ""]) {
			expect(capabilityForOAuthScope(scope)).toBeNull();
		}
	});
});
