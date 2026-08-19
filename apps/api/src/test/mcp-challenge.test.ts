import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedFixture, seedToken } from "./helpers";

// PROJ-651: RFC 9728 WWW-Authenticate challenges on the MCP endpoint.
//
// The challenge is the only discovery entry point an MCP client has, and Anthropic
// is explicit that Claude does not honour the header on a non-401 response. So these
// tests care about two things a JSON-body assertion cannot see: the transport-level
// status, and the header riding on it.
//
// A realistic https host throughout — resource_metadata is a URL built from the
// request, and a localhost assertion would not catch an origin-derivation bug.
const HOST = "https://projektor.example.com";

function mcpUrl(workspaceId: string): string {
	return `${HOST}/mcp/${workspaceId}`;
}

function rpc(method: string, params?: unknown) {
	return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

/** Parse `Bearer k="v", k2="v2"` into a map, so tests assert on values not substrings. */
function parseChallenge(header: string | null): Record<string, string> {
	expect(header).toBeTruthy();
	const bearer = header as string;
	expect(bearer.startsWith("Bearer ")).toBe(true);
	const out: Record<string, string> = {};
	for (const [, key, value] of bearer.slice(7).matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) {
		out[key] = value.replace(/\\(.)/g, "$1");
	}
	return out;
}

describe("MCP 401 carries an RFC 9728 challenge", () => {
	let workspaceId: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		workspaceId = fixture.workspace.id;
	});

	it("points at the per-workspace protected resource metadata document", async () => {
		const res = await SELF.fetch(mcpUrl(workspaceId), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: rpc("initialize"),
		});

		expect(res.status).toBe(401);
		const challenge = parseChallenge(res.headers.get("WWW-Authenticate"));
		// Per-workspace, not origin-level: Claude matches the PRM document's
		// `resource` against the URL the user typed, path component included.
		expect(challenge.resource_metadata).toBe(
			`${HOST}/.well-known/oauth-protected-resource/mcp/${workspaceId}`
		);
		expect(challenge.scope).toBe("projektor:read projektor:write");
	});

	it("derives resource_metadata from the request host, not a fixed origin", async () => {
		const other = "https://tenant.projektor.dev";
		const res = await SELF.fetch(`${other}/mcp/${workspaceId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: rpc("initialize"),
		});

		const challenge = parseChallenge(res.headers.get("WWW-Authenticate"));
		expect(challenge.resource_metadata).toBe(
			`${other}/.well-known/oauth-protected-resource/mcp/${workspaceId}`
		);
	});

	it("challenges an invalid bearer token too, not just a missing one", async () => {
		const res = await SELF.fetch(mcpUrl(workspaceId), {
			method: "POST",
			headers: { Authorization: "Bearer tok_not_a_real_token", "Content-Type": "application/json" },
			body: rpc("initialize"),
		});

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
	});
});

describe("/api/* 401s are unchanged", () => {
	// PROJ-430: the frontend reloads the page to re-authenticate on a 401, so the
	// shape of an /api/* 401 is load-bearing. The challenge must not leak onto it.
	it("carries no WWW-Authenticate header and the same bare body", async () => {
		const res = await SELF.fetch(`${HOST}/api/projects`);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("is unchanged for an invalid bearer token as well", async () => {
		const res = await SELF.fetch(`${HOST}/api/projects`, {
			headers: { Authorization: "Bearer tok_not_a_real_token" },
		});

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
	});
});

describe("insufficient scope is a 403 challenge, not a 200 with a JSON-RPC error", () => {
	let workspaceId: string;
	let readToken: string;

	beforeEach(async () => {
		const fixture = await seedFixture();
		workspaceId = fixture.workspace.id;
		readToken = await seedToken(fixture.workspace.id, fixture.user.id, { scopes: ["read"] });
	});

	async function callAsReadToken(method: string, params: unknown) {
		return SELF.fetch(mcpUrl(workspaceId), {
			method: "POST",
			headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json" },
			body: rpc(method, params),
		});
	}

	it("returns 403 with error=insufficient_scope on a write tool", async () => {
		const res = await callAsReadToken("tools/call", {
			name: "create_project",
			arguments: { name: "nope", key: "NOPE" },
		});

		// The status is the point. A 200 carrying a JSON-RPC error is invisible to
		// the client's step-up flow: Claude hands the text to the model as a tool
		// result and moves on, so the user reads "please sign in" prose in the chat
		// instead of being offered a Connect button.
		expect(res.status).toBe(403);

		const challenge = parseChallenge(res.headers.get("WWW-Authenticate"));
		expect(challenge.error).toBe("insufficient_scope");
		expect(challenge.resource_metadata).toBe(
			`${HOST}/.well-known/oauth-protected-resource/mcp/${workspaceId}`
		);
		// All scopes in one go — challenging incrementally would force a second
		// consent round-trip the moment the client touched another operation.
		expect(challenge.scope).toBe("projektor:read projektor:write");
	});

	it("keeps the JSON-RPC -32003 body so existing pk_ token callers are unaffected", async () => {
		const res = await callAsReadToken("tools/call", {
			name: "create_project",
			arguments: { name: "nope", key: "NOPE" },
		});

		const body = await res.json<{ error: { code: number; message: string } }>();
		expect(body.error.code).toBe(-32003);
		expect(body.error.message).toBe("Token lacks 'write' scope");
	});

	it("treats prompts/get the same way — it is gated by the same scope check", async () => {
		const res = await callAsReadToken("prompts/get", { name: "epic-goal", arguments: {} });

		expect(res.status).toBe(403);
		expect(parseChallenge(res.headers.get("WWW-Authenticate")).error).toBe("insufficient_scope");
	});

	it("still allows a read tool through on 200 with no challenge", async () => {
		const res = await callAsReadToken("tools/call", {
			name: "list_projects",
			arguments: {},
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
	});
});
