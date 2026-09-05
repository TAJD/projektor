import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// PROJ-655: the two public OAuth discovery documents.
//
// Every assertion here deliberately uses a realistic https host rather than
// http://localhost. Origin derivation is the bug-prone part of these documents —
// a hardcoded origin, or one taken from the wrong header, passes a localhost test
// and then emits a `resource` that no client can match in production.
const HOST = "https://projektor.example.com";
const WORKSPACE_ID = "ws-projektor";

const PRM_URL = `${HOST}/.well-known/oauth-protected-resource/mcp/${WORKSPACE_ID}`;
const AS_URL = `${HOST}/.well-known/oauth-authorization-server`;

describe("RFC 9728 protected resource metadata", () => {
	it("names the full per-workspace MCP URL as the resource, derived from the request host", async () => {
		const res = await SELF.fetch(PRM_URL);
		expect(res.status).toBe(200);

		const body = await res.json();
		// The exact-match requirement: this must equal the URL a user types into
		// Claude's connector dialog, path component included. An origin-level
		// `resource` here is the failure this ticket exists to prevent.
		expect(body).toEqual({
			resource: `${HOST}/mcp/${WORKSPACE_ID}`,
			authorization_servers: [HOST],
			bearer_methods_supported: ["header"],
			scopes_supported: ["projektor:read", "projektor:write"],
		});
	});

	it("derives the origin from the request rather than a fixed value", async () => {
		const other = "https://tenant.projektor.dev";
		const res = await SELF.fetch(`${other}/.well-known/oauth-protected-resource/mcp/abc`);

		const body = await res.json<{ resource: string; authorization_servers: string[] }>();
		expect(body.resource).toBe(`${other}/mcp/abc`);
		expect(body.authorization_servers).toEqual([other]);
	});

	it("does not advertise offline_access (the MCP spec says a resource SHOULD NOT)", async () => {
		const res = await SELF.fetch(PRM_URL);
		const body = await res.json<{ scopes_supported: string[] }>();
		expect(body.scopes_supported).not.toContain("offline_access");
	});

	it("answers for an unknown workspace id rather than leaking whether it exists", async () => {
		// A 404 here would be an existence oracle on an unauthenticated endpoint.
		// The document is derived entirely from the request URL and reveals nothing,
		// so an unknown id gets the same 200 as a real one; the id is rejected later,
		// at the MCP request itself, behind authentication.
		const res = await SELF.fetch(
			`${HOST}/.well-known/oauth-protected-resource/mcp/00000000-0000-0000-0000-000000000000`
		);
		expect(res.status).toBe(200);

		const real = await SELF.fetch(PRM_URL);
		expect(real.status).toBe(res.status);
	});

	it("is public — no Authorization header required, and readable cross-origin", async () => {
		const res = await SELF.fetch(PRM_URL);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
	});

	it("does not serve the origin-level variant, which could only claim a wrong resource", async () => {
		const res = await SELF.fetch(`${HOST}/.well-known/oauth-protected-resource`);
		expect(res.status).toBe(404);
	});
});

// PROJ-655: PROJ-650 routed /.well-known/* to the Worker, so an unmatched path under
// it now reaches index.ts's SPA catch-all, which in a real deploy answers 200 with the
// app shell — a success status carrying HTML to a client that asked for discovery JSON.
//
// The status alone cannot catch a regression here: the test runtime has no ASSETS
// binding, so the catch-all already 404s and both the fixed and broken versions look
// identical. The CONTENT TYPE is what distinguishes them — the explicit handlers
// answer application/json, while falling through to the catch-all yields Hono's
// text/plain "404 Not Found". Assert on that, or this test proves nothing.
describe("unmatched OAuth discovery paths 404 as JSON, never the SPA shell", () => {
	it.each([
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-protected-resource/not-mcp",
		"/.well-known/oauth-authorization-server/extra-segment",
		// PROJ-660: OIDC Discovery is an alternative route to the same metadata, so a
		// client may probe here. Found serving 200 text/html on a real deployment.
		"/.well-known/openid-configuration",
	])("%s", async (path) => {
		const res = await SELF.fetch(`${HOST}${path}`);
		expect(res.status).toBe(404);
		expect(res.headers.get("Content-Type")).toContain("application/json");
	});

	it("leaves unrelated /.well-known paths alone for the asset handler", async () => {
		// Scoping matters: a blanket catch-all on /.well-known would break a
		// self-hoster's security.txt or ACME challenge, which must still fall through.
		const res = await SELF.fetch(`${HOST}/.well-known/security.txt`);
		expect(res.headers.get("Content-Type") ?? "").not.toContain("application/json");
	});
});

describe("RFC 8414 authorization server metadata", () => {
	it("advertises the OAuth 2.1 endpoints and grants", async () => {
		const res = await SELF.fetch(AS_URL);
		expect(res.status).toBe(200);

		const body = await res.json<Record<string, unknown>>();
		expect(body.issuer).toBe(HOST);
		expect(body.authorization_endpoint).toBe(`${HOST}/oauth/authorize`);
		expect(body.token_endpoint).toBe(`${HOST}/oauth/token`);
		// Deliberately the token endpoint, not a distinct /oauth/revoke: the provider
		// serves RFC 7009 revocation there. A separate path would 200 through the SPA
		// fallback and report success for a revocation that never happened.
		expect(body.revocation_endpoint).toBe(`${HOST}/oauth/token`);
		expect(body.response_types_supported).toEqual(["code"]);
		expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
	});

	it("mandates PKCE S256 and never offers plain", async () => {
		const res = await SELF.fetch(AS_URL);
		const body = await res.json<{ code_challenge_methods_supported: string[] }>();
		expect(body.code_challenge_methods_supported).toEqual(["S256"]);
	});

	it("sets both CIMD gating flags — Claude needs both or it falls back to DCR", async () => {
		const res = await SELF.fetch(AS_URL);
		const body = await res.json<{
			client_id_metadata_document_supported: boolean;
			token_endpoint_auth_methods_supported: string[];
			registration_endpoint?: string;
		}>();

		expect(body.client_id_metadata_document_supported).toBe(true);
		expect(body.token_endpoint_auth_methods_supported).toContain("none");
		// Advertising a registration endpoint would make clients prefer deprecated
		// RFC 7591 DCR over CIMD, defeating the two flags above.
		expect(body.registration_endpoint).toBeUndefined();
	});

	it("advertises RFC 9207 iss support, since PROJ-656 emits it", async () => {
		const res = await SELF.fetch(AS_URL);
		const body = await res.json<{ authorization_response_iss_parameter_supported: boolean }>();
		expect(body.authorization_response_iss_parameter_supported).toBe(true);
	});

	it("derives every endpoint from the request host", async () => {
		const other = "https://tenant.projektor.dev";
		const res = await SELF.fetch(`${other}/.well-known/oauth-authorization-server`);
		const body = await res.json<{ issuer: string; token_endpoint: string }>();

		expect(body.issuer).toBe(other);
		expect(body.token_endpoint).toBe(`${other}/oauth/token`);
	});

	it("is public and cacheable", async () => {
		const res = await SELF.fetch(AS_URL);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

describe("discovery endpoints are rate-limited", () => {
	it("returns 429 once the unauthenticated IP limit is exceeded", async () => {
		// wrangler.test.toml sets RATE_LIMIT_AUTH_MAX=3, and setup.ts clears the
		// counter before each test, so the 4th request in this test is the first to
		// exceed it. Without the /.well-known/* limiter mount these would all be 200:
		// rateLimitMiddleware was previously mounted on /api/* and /mcp/* only.
		env.RATE_LIMIT_TEST_NOW_MS = String(Date.now());
		const ip = { "CF-Connecting-IP": "203.0.113.7" };
		for (let i = 0; i < 3; i++) {
			expect((await SELF.fetch(AS_URL, { headers: ip })).status).toBe(200);
		}
		expect((await SELF.fetch(AS_URL, { headers: ip })).status).toBe(429);
		env.RATE_LIMIT_TEST_NOW_MS = undefined;
	});
});
