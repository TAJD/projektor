/**
 * PROJ-79 — Auth-middleware & MCP error-mapping tests
 *
 * Coverage:
 *  1. Token expiry  — expired api_tokens return 401
 *  2. CF Access JWT — valid/expired/malformed JWTs via verifyJwtPayload (injectable keys)
 *  3. /auth endpoints — GET /auth/me, POST /auth/tokens, DELETE /auth/tokens/:id
 *  4. MCP error contract — serviceErr → JSON-RPC error codes, malformed bodies, unknown workspace
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthCachesForTests, verifyJwtPayload } from "../middleware/auth";
import {
	authHeaders,
	hashToken,
	seedFixture,
	seedMember,
	seedToken,
	seedWorkspace,
	seedWorkspaceRoles,
} from "./helpers";

// ---------------------------------------------------------------------------
// JWT generation utilities (used only by CF Access JWT tests)
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

function encodeJwtPart(obj: unknown): string {
	return b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signTestJwt(
	privateKey: CryptoKey,
	payload: Record<string, unknown>
): Promise<string> {
	const header = encodeJwtPart({ alg: "RS256", typ: "JWT" });
	const body = encodeJwtPart(payload);
	const input = new TextEncoder().encode(`${header}.${body}`);
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, input);
	return `${header}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// PROJ-79 §1: Token expiry
// ---------------------------------------------------------------------------

describe("PROJ-79: token expiry", () => {
	it("expired api_token (expires_at < now) returns 401", async () => {
		const fixture = await seedFixture();
		// Seed a second token for the same user/workspace that is already expired
		const expiredToken = await seedToken(fixture.workspace.id, fixture.user.id, {
			expiresAt: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(expiredToken, fixture.workspace.slug),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/expired/i);
	});

	it("non-expired api_token is accepted", async () => {
		const fixture = await seedFixture();
		// Token that expires in the future
		const futureToken = await seedToken(fixture.workspace.id, fixture.user.id, {
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		});

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(futureToken, fixture.workspace.slug),
		});
		expect(res.status).toBe(200);
	});

	it("api_token with no expires_at never expires", async () => {
		const fixture = await seedFixture(); // seedFixture uses seedToken without expiresAt
		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(fixture.token, fixture.workspace.slug),
		});
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// PROJ-79 §2: CF Access JWT — verifyJwtPayload (injectable keys, no network)
// ---------------------------------------------------------------------------

describe("PROJ-79: CF Access JWT verification (verifyJwtPayload unit tests)", () => {
	// Generate RSA key pair once for the whole describe block
	let privateKey: CryptoKey;
	let publicJwk: JsonWebKey;
	const TEST_AUDIENCE = "test-audience-abc";
	const TEST_ISSUER = "https://test.cloudflareaccess.com";
	const TEST_EMAIL = "cf-user@example.com";

	beforeAll(async () => {
		const keyPair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"]
		)) as CryptoKeyPair;
		privateKey = keyPair.privateKey;
		publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
	});

	it("valid signed JWT with correct audience and issuer is accepted", async () => {
		const now = Math.floor(Date.now() / 1000);
		const jwt = await signTestJwt(privateKey, {
			exp: now + 3600,
			aud: TEST_AUDIENCE,
			iss: TEST_ISSUER,
			email: TEST_EMAIL,
		});

		const result = await verifyJwtPayload(jwt, [publicJwk], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).not.toBeNull();
		expect(result?.email).toBe(TEST_EMAIL);
	});

	it("expired JWT (exp < now) is rejected", async () => {
		const now = Math.floor(Date.now() / 1000);
		const jwt = await signTestJwt(privateKey, {
			exp: now - 10, // already expired
			aud: TEST_AUDIENCE,
			iss: TEST_ISSUER,
			email: TEST_EMAIL,
		});

		const result = await verifyJwtPayload(jwt, [publicJwk], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).toBeNull();
	});

	it("JWT with wrong audience is rejected", async () => {
		const now = Math.floor(Date.now() / 1000);
		const jwt = await signTestJwt(privateKey, {
			exp: now + 3600,
			aud: "wrong-audience",
			iss: TEST_ISSUER,
			email: TEST_EMAIL,
		});

		const result = await verifyJwtPayload(jwt, [publicJwk], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).toBeNull();
	});

	it("JWT with wrong issuer is rejected", async () => {
		const now = Math.floor(Date.now() / 1000);
		const jwt = await signTestJwt(privateKey, {
			exp: now + 3600,
			aud: TEST_AUDIENCE,
			iss: "https://evil.com",
			email: TEST_EMAIL,
		});

		const result = await verifyJwtPayload(jwt, [publicJwk], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).toBeNull();
	});

	it("JWT with wrong signature (corrupt last segment) is rejected", async () => {
		const now = Math.floor(Date.now() / 1000);
		const validJwt = await signTestJwt(privateKey, {
			exp: now + 3600,
			aud: TEST_AUDIENCE,
			iss: TEST_ISSUER,
			email: TEST_EMAIL,
		});
		const parts = validJwt.split(".");
		// Corrupt the signature by appending a char
		const corruptJwt = `${parts[0]}.${parts[1]}.${parts[2]}X`;

		const result = await verifyJwtPayload(corruptJwt, [publicJwk], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).toBeNull();
	});

	it("JWT with no matching key in the keyset is rejected", async () => {
		const now = Math.floor(Date.now() / 1000);
		const jwt = await signTestJwt(privateKey, {
			exp: now + 3600,
			aud: TEST_AUDIENCE,
			iss: TEST_ISSUER,
			email: TEST_EMAIL,
		});

		// Pass an empty keyset — no keys to verify against
		const result = await verifyJwtPayload(jwt, [], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).toBeNull();
	});

	it("malformed JWT (wrong number of segments) is rejected", async () => {
		const result = await verifyJwtPayload("only.two", [publicJwk], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).toBeNull();
	});

	it("JWT with non-RS256 algorithm header is rejected", async () => {
		// Manually craft a JWT with alg: HS256 to bypass the alg check
		const now = Math.floor(Date.now() / 1000);
		const header = encodeJwtPart({ alg: "HS256", typ: "JWT" });
		const body = encodeJwtPart({
			exp: now + 3600,
			aud: TEST_AUDIENCE,
			iss: TEST_ISSUER,
			email: TEST_EMAIL,
		});
		// Sign with RS256 anyway — the alg check fires before signature verification
		const input = new TextEncoder().encode(`${header}.${body}`);
		const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, input);
		const jwt = `${header}.${body}.${b64urlEncode(new Uint8Array(sig))}`;

		const result = await verifyJwtPayload(jwt, [publicJwk], TEST_AUDIENCE, TEST_ISSUER);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// PROJ-79 §2b: CF Access JWT — HTTP-level rejection paths
// These tests go through SELF.fetch to verify the middleware rejects early
// without requiring the JWKS fetch path (network or KV).
// ---------------------------------------------------------------------------

describe("PROJ-79: CF Access JWT HTTP rejection paths", () => {
	it("malformed Cf-Access-Jwt-Assertion header returns 401", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: {
				"Cf-Access-Jwt-Assertion": "not-a-valid-jwt",
				"X-Workspace-Slug": "any-slug",
			},
		});
		expect(res.status).toBe(401);
	});

	it("JWT with only two segments returns 401", async () => {
		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: {
				"Cf-Access-Jwt-Assertion": "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6InRlc3QifQ",
				"X-Workspace-Slug": "any-slug",
			},
		});
		expect(res.status).toBe(401);
	});

	it("JWT with non-RS256 alg header returns 401", async () => {
		// header: {"alg":"HS256"}, payload: {"exp": far-future, "email":"x"}, bogus sig
		const header = btoa(JSON.stringify({ alg: "HS256" }))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=/g, "");
		const payload = btoa(
			JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, email: "x@x.com" })
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=/g, "");
		const jwt = `${header}.${payload}.fakesig`;

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: {
				"Cf-Access-Jwt-Assertion": jwt,
				"X-Workspace-Slug": "any-slug",
			},
		});
		expect(res.status).toBe(401);
	});

	it("expired CF Access JWT (exp < now) returns 401 before any key fetch", async () => {
		const header = encodeJwtPart({ alg: "RS256", typ: "JWT" });
		const payload = encodeJwtPart({
			exp: Math.floor(Date.now() / 1000) - 60, // already expired
			email: "old@example.com",
		});
		const jwt = `${header}.${payload}.fakesig`;

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: {
				"Cf-Access-Jwt-Assertion": jwt,
				"X-Workspace-Slug": "any-slug",
			},
		});
		expect(res.status).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// PROJ-354: isolate-local auth caches survive KV backing-store loss
// (getCfAccessKeys / upsertUserByEmail are memoized per-isolate so most
// requests never touch KV at all — this proves the local cache, not just KV,
// is what's serving the second request).
// ---------------------------------------------------------------------------

describe("PROJ-354: CF Access auth caches are isolate-local", () => {
	it("second CF Access login succeeds after both KV cache entries are deleted", async () => {
		const keyPair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"]
		)) as CryptoKeyPair;
		const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

		const domain = "test-cf-access.example.com";
		const audience = "proj-354-audience";
		const email = `proj-354-${crypto.randomUUID().slice(0, 8)}@example.com`;

		env.CF_ACCESS_TEAM_DOMAIN = domain;
		env.CF_ACCESS_AUDIENCE = audience;

		// Pre-seed the JWKS cache directly in KV, bypassing the real network fetch
		// that getCfAccessKeys would otherwise make on a cold cache.
		await env.KV.put("cf-access-certs", JSON.stringify([publicJwk]));

		const jwt = await signTestJwt(keyPair.privateKey, {
			exp: Math.floor(Date.now() / 1000) + 3600,
			aud: audience,
			iss: `https://${domain}`,
			email,
		});

		const first = await SELF.fetch("http://localhost/auth/me", {
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { user: { id: string; email: string } };
		expect(firstBody.user.email).toBe(email);

		// Delete both KV entries the first request would have populated. If the
		// second request only relied on KV, it would now have to re-fetch the
		// JWKS over the network (which fails in this test env) and re-run the
		// D1 upsert path from scratch — it should instead be served entirely
		// from the isolate-local caches.
		await env.KV.delete("cf-access-certs");
		await env.KV.delete(`user-by-email:${email}`);

		const second = await SELF.fetch("http://localhost/auth/me", {
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		});
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as { user: { id: string; email: string } };
		expect(secondBody.user.email).toBe(email);
		expect(secondBody.user.id).toBe(firstBody.user.id);
	});
});

// ---------------------------------------------------------------------------
// PROJ-358: a signature that doesn't match any cached JWKS key forces one
// rate-limited refetch and retry, instead of failing every login until both
// cache layers expire on their own.
// ---------------------------------------------------------------------------

describe("PROJ-358: JWKS force-refresh on signature verification failure", () => {
	it("uncached-key token authenticates via forced refresh; bad sig within cooldown doesn't refetch again", async () => {
		const genKeyPair = () =>
			crypto.subtle.generateKey(
				{
					name: "RSASSA-PKCS1-v1_5",
					modulusLength: 2048,
					publicExponent: new Uint8Array([1, 0, 1]),
					hash: "SHA-256",
				},
				true,
				["sign", "verify"]
			) as Promise<CryptoKeyPair>;

		// `otherKeyPair` is never returned by the stub below, so a token signed
		// with it never matches whatever the cache holds — used for the
		// cooldown assertion without needing a second real refresh.
		const currentKeyPair = await genKeyPair();
		const otherKeyPair = await genKeyPair();
		const currentPublicJwk = (await crypto.subtle.exportKey(
			"jwk",
			currentKeyPair.publicKey
		)) as JsonWebKey;

		const domain = `proj-358-${crypto.randomUUID().slice(0, 8)}.example.com`;
		const audience = "proj-358-audience";
		const email = `proj-358-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const now = Math.floor(Date.now() / 1000);

		env.CF_ACCESS_TEAM_DOMAIN = domain;
		env.CF_ACCESS_AUDIENCE = audience;

		let fetchCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				fetchCalls++;
				return new Response(JSON.stringify({ keys: [currentPublicJwk] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			})
		);

		try {
			// Whatever's already cached (isolate-local from an earlier test, or
			// nothing) certainly doesn't verify a brand-new key pair's signature —
			// this forces getCfAccessKeys to refetch (via the stub) and retry.
			const currentJwt = await signTestJwt(currentKeyPair.privateKey, {
				exp: now + 3600,
				aud: audience,
				iss: `https://${domain}`,
				email,
			});
			const rotated = await SELF.fetch("http://localhost/auth/me", {
				headers: { "Cf-Access-Jwt-Assertion": currentJwt },
			});
			expect(rotated.status).toBe(200);
			expect(fetchCalls).toBe(1);

			// The cache now holds only currentPublicJwk, so a token signed by an
			// unrelated key still doesn't verify — but the forced refresh above
			// happened moments ago, so the cooldown should block a second fetch.
			const badJwt = await signTestJwt(otherKeyPair.privateKey, {
				exp: now + 3600,
				aud: audience,
				iss: `https://${domain}`,
				email,
			});
			const stillBad = await SELF.fetch("http://localhost/auth/me", {
				headers: { "Cf-Access-Jwt-Assertion": badJwt },
			});
			expect(stillBad.status).toBe(401);
			expect(fetchCalls).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// ---------------------------------------------------------------------------
// PROJ-360: last_used_at is a coarse audit field, throttled so bearer/agent
// traffic (the hottest auth path) doesn't rewrite it on every single request.
// ---------------------------------------------------------------------------

describe("PROJ-360: api_tokens.last_used_at write throttling", () => {
	it("a request within the throttle window does not rewrite a recent last_used_at", async () => {
		const fixture = await seedFixture();
		const hash = await hashToken(fixture.token);
		const now = Math.floor(Date.now() / 1000);
		const recentTimestamp = now - 30; // inside the 60s throttle window

		await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
			.bind(recentTimestamp, hash)
			.run();

		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		expect(res.status).toBe(200);

		const row = await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE token_hash = ?")
			.bind(hash)
			.first<{ last_used_at: number }>();
		expect(row?.last_used_at).toBe(recentTimestamp);
	});

	it("a request outside the throttle window (or with no prior value) updates last_used_at", async () => {
		const fixture = await seedFixture();
		const hash = await hashToken(fixture.token);
		const now = Math.floor(Date.now() / 1000);
		const staleTimestamp = now - 120; // outside the 60s throttle window

		await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
			.bind(staleTimestamp, hash)
			.run();

		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		expect(res.status).toBe(200);

		const row = await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE token_hash = ?")
			.bind(hash)
			.first<{ last_used_at: number }>();
		expect(row?.last_used_at).not.toBe(staleTimestamp);
		expect(row?.last_used_at).toBeGreaterThanOrEqual(now);
	});
});

// ---------------------------------------------------------------------------
// PROJ-274 (C1): no cached auth path can bypass scope enforcement
// ---------------------------------------------------------------------------

describe("PROJ-274: read-scoped token is denied write on every request", () => {
	it("read-only token gets 403 on POST /api/projects, never a cached bypass", async () => {
		const fixture = await seedFixture();
		const readOnlyToken = await seedToken(fixture.workspace.id, fixture.user.id, {
			scopes: ["read"],
		});

		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: {
				...authHeaders(readOnlyToken, fixture.workspace.slug),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "Blocked", key: "BLK" }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/scope/i);
	});

	it("read-only token gets a JSON-RPC scope error calling a write MCP tool, never a cached bypass", async () => {
		const fixture = await seedFixture();
		const readOnlyToken = await seedToken(fixture.workspace.id, fixture.user.id, {
			scopes: ["read"],
		});

		const res = await SELF.fetch(`http://localhost/mcp/${fixture.workspace.id}`, {
			method: "POST",
			headers: authHeaders(readOnlyToken, fixture.workspace.slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create_project", arguments: { name: "Blocked", key: "BLK" } },
			}),
		});
		const body = (await res.json()) as { error?: { code: number; message: string } };
		expect(body.error).toBeDefined();
		expect(body.error?.code).toBe(-32003);
		expect(body.error?.message).toMatch(/scope/i);
	});

	it("workspace-scoped token used against a different member workspace returns 403 (PROJ-16 confinement)", async () => {
		const fixture = await seedFixture();
		const otherWs = await seedWorkspace(`ws2-${crypto.randomUUID().slice(0, 8)}`);
		await seedMember(otherWs.id, fixture.user.id, "member");

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(fixture.token, otherWs.slug),
		});
		expect(res.status).toBe(403);
	});

	// PROJ-432 folded the workspace lookup and the membership lookup into one LEFT JOIN.
	// The two failure modes it has to keep apart: no row at all is a workspace that doesn't
	// exist (404, covered above), a row with no membership is a non-member (403 — this).
	// Collapsing them would leak workspace existence, or hide it from legitimate members.
	it("an existing workspace the caller is not a member of returns 403, not 404", async () => {
		const fixture = await seedFixture();
		await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.bind(fixture.workspace.id, fixture.user.id)
			.run();

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: authHeaders(fixture.token, fixture.workspace.slug),
		});
		expect(res.status).toBe(403);
	});
});

// ---------------------------------------------------------------------------
// PROJ-660: the dev bypass must not cover the MCP endpoint
// ---------------------------------------------------------------------------

describe("PROJ-660: dev bypass and /mcp/", () => {
	afterEach(() => {
		env.DEV_USER_EMAIL = "";
	});

	// A remote MCP client only learns it needs a credential from the 401 and the
	// challenge on it. If the bypass answered here the server would be claiming it
	// wants no credential at all, and no connector flow could ever start.
	it("still 401s with the RFC 9728 challenge when DEV_USER_EMAIL is set", async () => {
		const ws = await seedWorkspace();
		env.DEV_USER_EMAIL = "dev@projektor.dev";

		const res = await SELF.fetch(`http://localhost/mcp/${ws.id}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
	});

	it("still logs a browser request in, which is what the bypass is for", async () => {
		env.DEV_USER_EMAIL = "dev@projektor.dev";

		const res = await SELF.fetch("http://localhost/auth/me");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { email: string } };
		expect(body.user.email).toBe("dev@projektor.dev");
	});
});

// ---------------------------------------------------------------------------
// PROJ-373: opt-in anonymous public-viewer fallback
// ---------------------------------------------------------------------------

describe("PROJ-373: PUBLIC_READ_ONLY anonymous viewer", () => {
	// Every test in this block flips PUBLIC_READ_ONLY/DEFAULT_WORKSPACE_SLUG on the shared
	// worker env — reset them so later describe blocks (which assume the defaults) don't
	// see an anonymous viewer where they expect a 401.
	afterEach(() => {
		env.PUBLIC_READ_ONLY = undefined;
		env.DEFAULT_WORKSPACE_SLUG = "projektor";
	});

	it("anonymous request still 401s when PUBLIC_READ_ONLY is unset (default)", async () => {
		env.PUBLIC_READ_ONLY = undefined;
		const res = await SELF.fetch("http://localhost/auth/me");
		expect(res.status).toBe(401);
	});

	it("anonymous request is provisioned as viewer of the default workspace when PUBLIC_READ_ONLY is on", async () => {
		const slug = `proj-373-${crypto.randomUUID().slice(0, 8)}`;
		await seedWorkspace(slug);
		env.DEFAULT_WORKSPACE_SLUG = slug;
		env.PUBLIC_READ_ONLY = "true";

		const res = await SELF.fetch("http://localhost/auth/me");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			user: { email: string };
			workspaces: Array<{ slug: string; role: string }>;
		};
		expect(body.user.email).toBe("public-viewer@projektor.local");
		const membership = body.workspaces.find((w) => w.slug === slug);
		expect(membership?.role).toBe("viewer");
	});

	it("a real CF Access session is not demoted to anonymous viewer when PUBLIC_READ_ONLY is also on", async () => {
		const keyPair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"]
		)) as CryptoKeyPair;
		const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

		const domain = `proj-373-cf.example.com`;
		const audience = "proj-373-audience";
		const email = `proj-373-real-${crypto.randomUUID().slice(0, 8)}@example.com`;

		env.CF_ACCESS_TEAM_DOMAIN = domain;
		env.CF_ACCESS_AUDIENCE = audience;
		env.PUBLIC_READ_ONLY = "true";
		// The PROJ-354 test above already warmed the isolate-local certs cache with its own
		// keypair; without a reset, getCfAccessKeys would serve those stale keys instead of
		// fetching the ones seeded below, and this JWT would fail to verify.
		resetAuthCachesForTests();
		await env.KV.put("cf-access-certs", JSON.stringify([publicJwk]));

		const jwt = await signTestJwt(keyPair.privateKey, {
			exp: Math.floor(Date.now() / 1000) + 3600,
			aud: audience,
			iss: `https://${domain}`,
			email,
		});

		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { email: string } };
		expect(body.user.email).toBe(email);
	});

	it("anonymous viewer is blocked from writes (403), same as any viewer-role member", async () => {
		const slug = `proj-373-write-${crypto.randomUUID().slice(0, 8)}`;
		await seedWorkspace(slug);
		env.DEFAULT_WORKSPACE_SLUG = slug;
		env.PUBLIC_READ_ONLY = "true";

		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: { "X-Workspace-Slug": slug, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Blocked", key: "BLK" }),
		});
		expect(res.status).toBe(403);
	});
});

// ---------------------------------------------------------------------------
// PROJ-79 §3: /auth endpoints
// ---------------------------------------------------------------------------

describe("PROJ-79: GET /auth/me", () => {
	it("returns 401 without any authentication", async () => {
		const res = await SELF.fetch("http://localhost/auth/me");
		expect(res.status).toBe(401);
	});

	it("returns 401 with a wrong bearer token", async () => {
		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: { Authorization: "Bearer tok_totally_fake_token" },
		});
		expect(res.status).toBe(401);
	});

	it("returns user info and workspaces with a valid token", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			user: { id: string; email: string };
			workspaces: Array<{ id: string; role: string }>;
		};
		expect(body.user.id).toBe(fixture.user.id);
		expect(body.user.email).toBe(fixture.user.email);
		expect(Array.isArray(body.workspaces)).toBe(true);
		expect(body.workspaces.length).toBeGreaterThan(0);
		expect(body.workspaces[0].id).toBe(fixture.workspace.id);
	});

	it("returns all workspaces the user belongs to", async () => {
		const fixture = await seedFixture();
		const ws2 = await seedWorkspace(`ws2-${crypto.randomUUID().slice(0, 8)}`);
		await seedMember(ws2.id, fixture.user.id, "viewer");

		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		const body = (await res.json()) as { workspaces: Array<{ id: string }> };
		const ids = body.workspaces.map((w) => w.id);
		expect(ids).toContain(fixture.workspace.id);
		expect(ids).toContain(ws2.id);
	});
});

describe("PROJ-79: POST /auth/tokens", () => {
	it("creates a personal token and returns it", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: "ci-token",
				workspaceId: fixture.workspace.id,
				scopes: ["read", "write"],
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string };
		expect(typeof body.token).toBe("string");
		expect(body.token.length).toBeGreaterThan(0);
	});

	it("returns 400 when workspaceId is not a UUID", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "t", workspaceId: "not-a-uuid", scopes: ["read"] }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 when scopes array is empty", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "t", workspaceId: fixture.workspace.id, scopes: [] }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 401 without authentication", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "t", workspaceId: fixture.workspace.id, scopes: ["read"] }),
		});
		expect(res.status).toBe(401);
	});
});

describe("PROJ-79: DELETE /auth/tokens/:id", () => {
	it("deletes a token the user owns and returns ok", async () => {
		const fixture = await seedFixture();

		// Create a second token to delete (cannot delete the fixture token we're using for auth)
		const createRes = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: "to-delete",
				workspaceId: fixture.workspace.id,
				scopes: ["read"],
			}),
		});
		expect(createRes.status).toBe(201);

		// Retrieve the token ID by looking up the DB (the POST response only returns token value)
		const tokenRow = await env.DB.prepare(
			"SELECT id FROM api_tokens WHERE name = ? AND workspace_id = ?"
		)
			.bind("to-delete", fixture.workspace.id)
			.first<{ id: string }>();
		expect(tokenRow).not.toBeNull();

		const deleteRes = await SELF.fetch(`http://localhost/auth/tokens/${tokenRow!.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		expect(deleteRes.status).toBe(200);
		const body = (await deleteRes.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	it("cannot delete another user's token (silently no-ops, returns ok)", async () => {
		// The DELETE handler scopes by user_id, so deleting another user's token
		// silently succeeds (no row deleted). This is the current behaviour — confirmed here.
		const alice = await seedFixture();
		const bob = await seedFixture();

		// Bob's token: retrieve its ID
		const bobTokenRow = await env.DB.prepare(
			"SELECT id FROM api_tokens WHERE workspace_id = ? AND user_id = ? LIMIT 1"
		)
			.bind(bob.workspace.id, bob.user.id)
			.first<{ id: string }>();

		// Alice tries to delete Bob's token — the WHERE user_id = alice.user.id clause filters it out
		const res = await SELF.fetch(`http://localhost/auth/tokens/${bobTokenRow!.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${alice.token}` },
		});
		// The endpoint returns 200 ok (no error — just no rows deleted)
		expect(res.status).toBe(200);

		// Bob's token must still exist in the DB
		const stillThere = await env.DB.prepare("SELECT id FROM api_tokens WHERE id = ?")
			.bind(bobTokenRow!.id)
			.first<{ id: string }>();
		expect(stillThere).not.toBeNull();
	});

	it("returns 401 without authentication", async () => {
		const res = await SELF.fetch(`http://localhost/auth/tokens/${crypto.randomUUID()}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// PROJ-79 §4: MCP error contract
// ---------------------------------------------------------------------------

describe("PROJ-79: MCP error contract — serviceErr → JSON-RPC error codes", () => {
	let workspaceId: string;
	let slug: string;
	let ownerHeaders: Record<string, string>;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		workspaceId = fixture.workspace.id;
		slug = fixture.workspace.slug;
		ownerHeaders = authHeaders(fixture.token, slug);
	});

	async function mcp(name: string, args: unknown, headers = ownerHeaders) {
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
		return res.json() as Promise<{
			jsonrpc: string;
			id: unknown;
			result?: unknown;
			error?: { code: number; message: string };
		}>;
	}

	// ValidationError → -32602
	it("ValidationError (e.g. empty wiki title) maps to JSON-RPC -32602", async () => {
		const resp = await mcp("create_wiki_page", { title: "", content: "body" });
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32602);
	});

	// NotFoundError → -32000
	it("NotFoundError (unknown issue id) maps to JSON-RPC -32000", async () => {
		const resp = await mcp("get_issue", { id: crypto.randomUUID() });
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32000);
		expect(resp.error?.message).toMatch(/not found/i);
	});

	// ForbiddenError → -32000 (triggered by viewer calling a restricted tool)
	it("ForbiddenError maps to JSON-RPC -32000", async () => {
		const roles = await seedWorkspaceRoles();
		const viewerHeaders = authHeaders(roles.viewer.token, roles.workspace.slug);

		const res = await SELF.fetch(`http://localhost/mcp/${roles.workspace.id}`, {
			method: "POST",
			headers: viewerHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create_task_type", arguments: { key: "epic", name: "Epic" } },
			}),
		});
		const resp = (await res.json()) as { error?: { code: number } };
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32000);
	});

	// ConflictError → -32000 (duplicate workspace slug)
	it("ConflictError (duplicate workspace slug) maps to JSON-RPC -32000", async () => {
		// Create workspace with a slug
		await mcp("create_workspace", { slug: "conflict-slug", name: "First" });
		// Create again with same slug → ConflictError
		const resp = await mcp("create_workspace", { slug: "conflict-slug", name: "Second" });
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32000);
		expect(resp.error?.message).toMatch(/slug already taken/i);
	});
});

describe("PROJ-79: MCP protocol validation", () => {
	let workspaceId: string;
	let slug: string;
	let ownerHeaders: Record<string, string>;

	beforeEach(async () => {
		const fixture = await seedFixture({ role: "owner" });
		workspaceId = fixture.workspace.id;
		slug = fixture.workspace.slug;
		ownerHeaders = authHeaders(fixture.token, slug);
	});

	it("wrong jsonrpc version returns HTTP 400 with error code -32600", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({
				jsonrpc: "1.0", // wrong version
				id: 1,
				method: "tools/list",
				params: {},
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32600);
	});

	it("unknown method returns JSON-RPC error -32601", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "foo/bar", params: {} }),
		});
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32601);
	});

	it("unknown tool name returns JSON-RPC error -32601 with tool name in message", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "no_such_tool", arguments: {} },
			}),
		});
		const body = (await res.json()) as { error: { code: number; message: string } };
		expect(body.error.code).toBe(-32601);
		expect(body.error.message).toContain("no_such_tool");
	});

	it("unknown workspace slug returns 404 from workspaceMiddleware", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch(`http://localhost/mcp/${crypto.randomUUID()}`, {
			method: "POST",
			headers: {
				// Valid token but X-Workspace-Slug points to a non-existent workspace
				Authorization: `Bearer ${fixture.token}`,
				"X-Workspace-Slug": `nonexistent-${crypto.randomUUID().slice(0, 8)}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(res.status).toBe(404);
	});

	it("non-object params on tools/call is handled without crashing", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: "not-an-object",
			}),
		});
		// Any 2xx or 4xx is acceptable — the server must not crash (500)
		expect(res.status).not.toBe(500);
	});

	it("missing id field is handled (server echoes null/undefined id without crashing)", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: ownerHeaders,
			// No "id" field in the request body
			body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {} }),
		});
		// Server must respond with a valid JSON-RPC structure and not crash
		expect(res.status).not.toBe(500);
		const body = (await res.json()) as { jsonrpc: string };
		expect(body.jsonrpc).toBe("2.0");
	});
});

// ---------------------------------------------------------------------------
// PROJ-430: an auth *infrastructure* failure (the JWKS endpoint unreachable)
// must not masquerade as a session problem. The frontend reloads the page to
// re-authenticate on a 401 (PROJ-427), so answering a certs-fetch failure with
// a 401 sends the client off to re-login for something re-login cannot fix.
// It must also not be a bare, unlogged 500.
// ---------------------------------------------------------------------------

describe("PROJ-430: CF Access certs fetch failure", () => {
	it("returns 503, not 401 or 500, when the JWKS endpoint is unreachable", async () => {
		const keyPair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"]
		)) as CryptoKeyPair;

		const domain = "proj-430-unreachable.example.com";
		const audience = "proj-430-audience";
		env.CF_ACCESS_TEAM_DOMAIN = domain;
		env.CF_ACCESS_AUDIENCE = audience;

		// Cold both cache layers so validateCfAccessJwt has to hit the network,
		// which fails for this domain in the test runtime.
		resetAuthCachesForTests();
		await env.KV.delete("cf-access-certs");

		// Claims are entirely valid — only the certs fetch is broken.
		const jwt = await signTestJwt(keyPair.privateKey, {
			exp: Math.floor(Date.now() / 1000) + 3600,
			aud: audience,
			iss: `https://${domain}`,
			email: `proj-430-${crypto.randomUUID().slice(0, 8)}@example.com`,
		});

		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: { "Cf-Access-Jwt-Assertion": jwt },
		});

		expect(res.status).toBe(503);
		expect((await res.json()) as { error: string }).toEqual({
			error: "Authentication temporarily unavailable",
		});
	});
});
