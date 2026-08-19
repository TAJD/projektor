import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAuthCachesForTests } from "../middleware/auth";
import { seedFixture, seedMember, seedToken, seedUser, seedWorkspace } from "./helpers";

// PROJ-656/657: the OAuth 2.1 authorization code flow, end to end.
//
// These tests drive the real provider, not a stand-in: a browser session consents, the
// client exchanges the code with a PKCE verifier, and the resulting access token is
// used against the MCP endpoint. What they are guarding is the seam between the OAuth
// library and projektor — who may consent, which workspace a grant is bound to, and
// whether that binding actually holds when the token is spent somewhere else.

const HOST = "https://projektor.example.com";
const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

// The rate limiter is IP-keyed for requests with no bearer token, and
// wrangler.test.toml sets RATE_LIMIT_AUTH_MAX=3. A whole authorization flow is more
// than three such requests, so each test gets its own bucket.
let clientIp: string;
function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { "CF-Connecting-IP": clientIp, ...extra };
}

// ---------------------------------------------------------------------------
// A Cloudflare Access session. The consent screen is deliberately unreachable by
// any credential except a signed-in human, so every happy-path test needs one.
// ---------------------------------------------------------------------------

const CF_DOMAIN = "test-oauth.example.com";
const CF_AUDIENCE = "oauth-test-audience";

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

let signingKey: CryptoKey;

async function installAccessKeys(): Promise<void> {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"]
	)) as CryptoKeyPair;
	signingKey = pair.privateKey;
	resetAuthCachesForTests();
	env.CF_ACCESS_TEAM_DOMAIN = CF_DOMAIN;
	env.CF_ACCESS_AUDIENCE = CF_AUDIENCE;
	await env.KV.put(
		"cf-access-certs",
		JSON.stringify([await crypto.subtle.exportKey("jwk", pair.publicKey)])
	);
}

async function accessJwt(email: string): Promise<string> {
	const part = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
	const header = part({ alg: "RS256", typ: "JWT" });
	const body = part({
		exp: Math.floor(Date.now() / 1000) + 3600,
		aud: CF_AUDIENCE,
		iss: `https://${CF_DOMAIN}`,
		email,
	});
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		signingKey,
		new TextEncoder().encode(`${header}.${body}`)
	);
	return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// A registered OAuth client, written straight into OAUTH_KV.
//
// The provider only exposes createClient through OAuthHelpers, which exists inside a
// request it is handling — there is no way to register a client from out here. Writing
// the record directly couples these tests to the library's storage layout (`client:<id>`
// holding a ClientInfo), which is the smaller of two evils: the alternative is a CIMD
// client, whose registration is an outbound HTTPS fetch of a metadata document that no
// test runtime can serve.
// ---------------------------------------------------------------------------

async function seedOAuthClient(
	redirectUris: string[] = [CLIENT_REDIRECT]
): Promise<{ clientId: string }> {
	const clientId = `test-client-${crypto.randomUUID().slice(0, 8)}`;
	await env.OAUTH_KV.put(
		`client:${clientId}`,
		JSON.stringify({
			clientId,
			redirectUris,
			clientName: "Test Connector",
			grantTypes: ["authorization_code", "refresh_token"],
			responseTypes: ["code"],
			registrationDate: Math.floor(Date.now() / 1000),
			// Public client: no secret, PKCE is the only proof of possession. This is
			// what Claude is, and what the metadata document advertises via
			// token_endpoint_auth_methods_supported: ["none"].
			tokenEndpointAuthMethod: "none",
		})
	);
	return { clientId };
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

function authorizeUrl(
	opts: Readonly<{
		clientId: string;
		resource?: string;
		scope?: string;
		challenge: string;
		redirectUri?: string;
		state?: string;
	}>
): string {
	const url = new URL(`${HOST}/oauth/authorize`);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", opts.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri ?? CLIENT_REDIRECT);
	url.searchParams.set("state", opts.state ?? "opaque-state");
	url.searchParams.set("code_challenge", opts.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (opts.scope !== undefined) url.searchParams.set("scope", opts.scope);
	if (opts.resource !== undefined) url.searchParams.set("resource", opts.resource);
	return url.toString();
}

/** The hidden signed field the consent form carries. */
function consentTokenFrom(html: string): string {
	const match = /name="consent_token" value="([^"]+)"/.exec(html);
	expect(match, "consent screen did not render a consent_token").toBeTruthy();
	return (match as RegExpExecArray)[1];
}

async function postConsent(token: string, decision: string, jwt: string): Promise<Response> {
	return SELF.fetch(`${HOST}/oauth/authorize`, {
		method: "POST",
		headers: browserHeaders({
			"Cf-Access-Jwt-Assertion": jwt,
			"Content-Type": "application/x-www-form-urlencoded",
		}),
		body: new URLSearchParams({ consent_token: token, decision }).toString(),
		redirect: "manual",
	});
}

// The token endpoint has its own IP-keyed bound (it is served by the provider and never
// reaches Hono's limiter), and the test limit is 3. Each call presents a fresh address
// so a multi-step flow is not throttled by a control that has its own test below.
async function exchange(body: Record<string, string>, ip?: string): Promise<Response> {
	return SELF.fetch(`${HOST}/oauth/token`, {
		method: "POST",
		headers: {
			"CF-Connecting-IP": ip ?? `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body).toString(),
	});
}

type TokenResponse = {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	scope?: string;
};

/** Consent and exchange in one go — the whole flow a connector performs. */
async function connect(opts: {
	email: string;
	workspaceId: string;
	scope?: string;
	redirectUris?: string[];
	redirectUri?: string;
}): Promise<{ tokens: TokenResponse; clientId: string; resource: string }> {
	const jwt = await accessJwt(opts.email);
	const { clientId } = await seedOAuthClient(opts.redirectUris);
	const { verifier, challenge } = await pkce();
	const resource = `${HOST}/mcp/${opts.workspaceId}`;

	const consentPage = await SELF.fetch(
		authorizeUrl({
			clientId,
			resource,
			scope: opts.scope,
			challenge,
			redirectUri: opts.redirectUri,
		}),
		{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }) }
	);
	expect(consentPage.status).toBe(200);

	const approved = await postConsent(consentTokenFrom(await consentPage.text()), "approve", jwt);
	expect(approved.status).toBe(302);

	const code = new URL(approved.headers.get("Location") as string).searchParams.get("code");
	expect(code).toBeTruthy();

	const res = await exchange({
		grant_type: "authorization_code",
		code: code as string,
		redirect_uri: opts.redirectUri ?? CLIENT_REDIRECT,
		client_id: clientId,
		code_verifier: verifier,
		resource,
	});
	expect(res.status).toBe(200);
	return { tokens: await res.json<TokenResponse>(), clientId, resource };
}

function mcpCall(workspaceId: string, token: string, name: string, args: unknown = {}) {
	return SELF.fetch(`${HOST}/mcp/${workspaceId}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
}

beforeEach(async () => {
	clientIp = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;
	await installAccessKeys();
});

describe("only a signed-in human reaches the consent screen", () => {
	it("401s an anonymous request", async () => {
		const { challenge } = await pkce();
		const { clientId } = await seedOAuthClient();
		const res = await SELF.fetch(authorizeUrl({ clientId, challenge }), {
			headers: browserHeaders(),
		});

		expect(res.status).toBe(401);
	});

	it("refuses an API token — a pk_ credential cannot mint an OAuth grant", async () => {
		// The escalation this blocks: a leaked read-scoped API token being spent on a
		// consent screen to obtain a longer-lived credential in the user's name.
		const fixture = await seedFixture();
		const token = await seedToken(fixture.workspace.id, fixture.user.id);
		const { challenge } = await pkce();
		const { clientId } = await seedOAuthClient();

		const res = await SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${fixture.workspace.id}` }),
			{ headers: { Authorization: `Bearer ${token}` } }
		);

		expect(res.status).toBe(403);
		expect(await res.text()).toContain("Sign-in required");
	});

	it("refuses the shared PUBLIC_READ_ONLY viewer", async () => {
		// An instance running as a public demo has nobody who can authorize a
		// connector. Consenting as the shared viewer would hand every anonymous visitor
		// on the internet a token for the demo workspace.
		env.PUBLIC_READ_ONLY = "true";
		try {
			const { challenge } = await pkce();
			const { clientId } = await seedOAuthClient();
			const res = await SELF.fetch(authorizeUrl({ clientId, challenge }), {
				headers: browserHeaders(),
			});

			expect(res.status).toBe(403);
			expect(await res.text()).toContain("Sign-in required");
		} finally {
			env.PUBLIC_READ_ONLY = undefined as unknown as string;
		}
	});
});

describe("the authorization request must name a workspace the user belongs to", () => {
	it("rejects a request with no resource parameter", async () => {
		const jwt = await accessJwt("resource-less@example.com");
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();

		const res = await SELF.fetch(authorizeUrl({ clientId, challenge }), {
			headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }),
			redirect: "manual",
		});

		// Redirected, not rendered: the redirect_uri was validated by parseAuthRequest,
		// so the client gets a real OAuth error instead of a callback that never fires.
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("Location") as string);
		expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
		expect(location.searchParams.get("error")).toBe("invalid_target");
		expect(location.searchParams.get("state")).toBe("opaque-state");
		// RFC 9207 — advertised in the AS metadata, so it has to actually be emitted.
		expect(location.searchParams.get("iss")).toBe(HOST);
	});

	it("rejects a resource that is not an MCP endpoint", async () => {
		const jwt = await accessJwt("wrong-shape@example.com");
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();

		const res = await SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/api/projects` }),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }), redirect: "manual" }
		);

		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("Location") as string).searchParams.get("error")).toBe(
			"invalid_target"
		);
	});

	it("refuses a workspace the signed-in user is not a member of", async () => {
		const outsider = "outsider@example.com";
		const other = await seedWorkspace();
		const jwt = await accessJwt(outsider);
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();

		const res = await SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${other.id}` }),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }), redirect: "manual" }
		);

		// Rendered locally on purpose. Bouncing back with access_denied would tell the
		// client whether this user is a member of that workspace.
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("Workspace unavailable");
	});
});

describe("the consent screen", () => {
	let workspaceId: string;
	let email: string;
	let jwt: string;

	beforeEach(async () => {
		const workspace = await seedWorkspace();
		workspaceId = workspace.id;
		email = `member-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const user = await seedUser(email);
		await seedMember(workspaceId, user.id, "member");
		jwt = await accessJwt(email);
	});

	it("names the workspace, the identity and the permissions being granted", async () => {
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();

		const res = await SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${workspaceId}` }),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }) }
		);
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		expect(body).toContain(email);
		expect(body).toContain("Test Connector");
		expect(body).toContain("Read issues");
		expect(body).toContain("Create and change issues");
	});

	it("warns when the client collects its response on the user's own machine", async () => {
		// Claude Code's callback. Any local process can bind that port, so the
		// "application" is not something projektor can vouch for.
		const { clientId } = await seedOAuthClient(["http://127.0.0.1:8976/callback"]);
		const { challenge } = await pkce();

		const res = await SELF.fetch(
			authorizeUrl({
				clientId,
				challenge,
				resource: `${HOST}/mcp/${workspaceId}`,
				redirectUri: "http://127.0.0.1:8976/callback",
			}),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }) }
		);

		expect(await res.text()).toContain("your own machine");
	});

	it("matches a loopback callback on a different ephemeral port (RFC 8252 §7.3)", async () => {
		// Claude Code registers one port and calls back on whatever it managed to bind.
		// Without the library's port-ignoring comparison this is where it breaks.
		const { clientId } = await seedOAuthClient(["http://127.0.0.1:1/callback"]);
		const { challenge } = await pkce();

		const res = await SELF.fetch(
			authorizeUrl({
				clientId,
				challenge,
				resource: `${HOST}/mcp/${workspaceId}`,
				redirectUri: "http://127.0.0.1:54321/callback",
			}),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }) }
		);

		expect(res.status).toBe(200);
	});

	it("refuses a redirect_uri the client never registered", async () => {
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();

		const res = await SELF.fetch(
			authorizeUrl({
				clientId,
				challenge,
				resource: `${HOST}/mcp/${workspaceId}`,
				redirectUri: "https://attacker.example/steal",
			}),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }), redirect: "manual" }
		);

		// Rendered, never redirected — this is the open-redirect case, and the
		// unvalidated URI is exactly where an error bounce must not go.
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
	});

	it("declining tells the client instead of leaving it waiting", async () => {
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();
		const consentPage = await SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${workspaceId}` }),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }) }
		);

		const res = await postConsent(consentTokenFrom(await consentPage.text()), "deny", jwt);

		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("Location") as string);
		expect(location.searchParams.get("error")).toBe("access_denied");
		expect(location.searchParams.get("code")).toBeNull();
	});
});

describe("the consent POST cannot be forged or replayed", () => {
	let workspaceId: string;
	let email: string;

	beforeEach(async () => {
		const workspace = await seedWorkspace();
		workspaceId = workspace.id;
		email = `csrf-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const user = await seedUser(email);
		await seedMember(workspaceId, user.id, "member");
	});

	it("rejects a POST with no consent token", async () => {
		// The CSRF case: another site can make the browser POST here with its cookies,
		// but it cannot produce this field.
		const res = await postConsent("", "approve", await accessJwt(email));
		expect(res.status).toBe(400);
	});

	it("rejects a tampered consent token", async () => {
		const jwt = await accessJwt(email);
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();
		const consentPage = await SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${workspaceId}` }),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }) }
		);
		const token = consentTokenFrom(await consentPage.text());
		const [body, sig] = token.split(".");

		// Same signature, different payload. Without the HMAC check this would consent
		// to whatever the altered payload says.
		const forged = `${body.slice(0, -4)}AAAA.${sig}`;
		expect((await postConsent(forged, "approve", jwt)).status).toBe(400);
	});

	it("rejects a consent token issued to a different user", async () => {
		const jwt = await accessJwt(email);
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();
		const consentPage = await SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${workspaceId}` }),
			{ headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }) }
		);
		const token = consentTokenFrom(await consentPage.text());

		const victim = `victim-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const victimUser = await seedUser(victim);
		await seedMember(workspaceId, victimUser.id, "member");

		// An intact, correctly-signed token, presented by someone else's session.
		const res = await postConsent(token, "approve", await accessJwt(victim));
		expect(res.status).toBe(400);
	});
});

describe("the issued token is bound to the workspace it was granted for", () => {
	let workspaceId: string;
	let email: string;

	beforeEach(async () => {
		const workspace = await seedWorkspace();
		workspaceId = workspace.id;
		email = `grantee-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const user = await seedUser(email);
		await seedMember(workspaceId, user.id, "admin");
	});

	it("completes the flow and authorizes an MCP call", async () => {
		const { tokens } = await connect({ email, workspaceId });

		expect(tokens.token_type).toBe("bearer");
		// `<userId>:<grantId>:<secret>` — the shape index.ts's dispatcher keys on.
		expect(tokens.access_token.split(":")).toHaveLength(3);

		const res = await mcpCall(workspaceId, tokens.access_token, "list_projects");
		expect(res.status).toBe(200);
		expect(await res.json<{ error?: unknown }>()).not.toHaveProperty("error");
	});

	it("refuses the same token against another workspace's MCP endpoint", async () => {
		// The whole point of RFC 8707 audience binding. The grant names one workspace;
		// spending it anywhere else must fail, even though the user is a real member of
		// this second workspace too.
		const second = await seedWorkspace();
		const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
			.bind(email)
			.first<{ id: string }>();
		await seedMember(second.id, (user as { id: string }).id, "admin");

		const { tokens } = await connect({ email, workspaceId });
		const res = await mcpCall(second.id, tokens.access_token, "list_projects");

		expect(res.status).toBe(401);
	});

	it("grants only the scopes that were asked for", async () => {
		const { tokens } = await connect({ email, workspaceId, scope: "projektor:read" });

		expect((await mcpCall(workspaceId, tokens.access_token, "list_projects")).status).toBe(200);

		const write = await mcpCall(workspaceId, tokens.access_token, "create_project", {
			name: "nope",
			key: "NOPE",
		});
		expect(write.status).toBe(403);
		expect(write.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
	});

	it("rotates the refresh token, keeping exactly one generation alive", async () => {
		const { tokens, clientId, resource } = await connect({ email, workspaceId });
		const refresh = (refresh_token: string) =>
			exchange({ grant_type: "refresh_token", refresh_token, client_id: clientId, resource });

		const first = await refresh(tokens.refresh_token);
		expect(first.status).toBe(200);
		const second = await (await first.json<TokenResponse>()).refresh_token;
		expect(second).not.toBe(tokens.refresh_token);

		// The library keeps the immediately-previous token usable on purpose: a refresh
		// response lost in transit would otherwise leave the client holding a token it
		// already spent and no way back. Asserted rather than assumed, because the
		// window is exactly one generation wide and the next assertion depends on it.
		const graced = await refresh(tokens.refresh_token);
		expect(graced.status).toBe(200);
		const third = await (await graced.json<TokenResponse>()).refresh_token;

		// Two rotations on, the original is out of the window. A refresh token that
		// stayed valid indefinitely would make every one ever issued a live credential.
		await refresh(third);
		const replay = await refresh(tokens.refresh_token);
		expect(replay.status).toBe(400);
		expect((await replay.json<{ error: string }>()).error).toBe("invalid_grant");
	});

	it("revokes a token at the endpoint the discovery document advertises", async () => {
		// The AS metadata names the token endpoint as revocation_endpoint. If that ever
		// drifts to a path nothing serves, the SPA fallback answers 200 and a client
		// reports a token revoked that is still live.
		const { tokens, clientId } = await connect({ email, workspaceId });

		const revoked = await exchange({ token: tokens.access_token, client_id: clientId });
		expect(revoked.status).toBe(200);

		expect((await mcpCall(workspaceId, tokens.access_token, "list_projects")).status).toBe(401);
	});
});

describe("the token endpoint's failure modes", () => {
	let workspaceId: string;
	let email: string;

	beforeEach(async () => {
		const workspace = await seedWorkspace();
		workspaceId = workspace.id;
		email = `token-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const user = await seedUser(email);
		await seedMember(workspaceId, user.id, "member");
	});

	it("replaying an authorization code revokes everything the grant produced", async () => {
		// OAuth 2.1's response to a stolen code: a second presentation means either the
		// client or an attacker is replaying, and the safe reading is that the code
		// leaked. Both parties lose the grant rather than one of them keeping it.
		const jwt = await accessJwt(email);
		const { clientId } = await seedOAuthClient();
		const { verifier, challenge } = await pkce();
		const resource = `${HOST}/mcp/${workspaceId}`;

		const consentPage = await SELF.fetch(authorizeUrl({ clientId, resource, challenge }), {
			headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }),
		});
		const approved = await postConsent(consentTokenFrom(await consentPage.text()), "approve", jwt);
		const code = new URL(approved.headers.get("Location") as string).searchParams.get(
			"code"
		) as string;
		const body = {
			grant_type: "authorization_code",
			code,
			redirect_uri: CLIENT_REDIRECT,
			client_id: clientId,
			code_verifier: verifier,
			resource,
		};

		const first = await exchange(body);
		expect(first.status).toBe(200);
		const tokens = await first.json<TokenResponse>();

		const replay = await exchange(body);
		expect(replay.status).toBe(400);
		// RFC 6749 §5.2 wire shape. Claude's refresh path keys off this exact code.
		expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

		// The access token already handed out is gone too — that is what makes this a
		// revocation rather than just a rejected second exchange.
		expect((await mcpCall(workspaceId, tokens.access_token, "list_projects")).status).toBe(401);
	});

	it("rejects an authorization request that omits code_challenge_method", async () => {
		// RFC 7636 says an absent method means `plain`. OAuth 2.1 does not offer plain,
		// and the metadata document advertises S256 only, so this must be refused
		// rather than silently downgraded.
		const jwt = await accessJwt(email);
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();
		const url = new URL(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${workspaceId}` })
		);
		url.searchParams.delete("code_challenge_method");

		const res = await SELF.fetch(url.toString(), {
			headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }),
			redirect: "manual",
		});

		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("Location") as string).searchParams.get("error")).toBe(
			"invalid_request"
		);
	});

	it("rejects a code exchanged with the wrong PKCE verifier", async () => {
		const jwt = await accessJwt(email);
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();
		const resource = `${HOST}/mcp/${workspaceId}`;

		const consentPage = await SELF.fetch(authorizeUrl({ clientId, resource, challenge }), {
			headers: browserHeaders({ "Cf-Access-Jwt-Assertion": jwt }),
		});
		const approved = await postConsent(consentTokenFrom(await consentPage.text()), "approve", jwt);
		const code = new URL(approved.headers.get("Location") as string).searchParams.get(
			"code"
		) as string;

		// A code intercepted from the redirect is worthless without the verifier that
		// only the client that started the flow holds.
		const res = await exchange({
			grant_type: "authorization_code",
			code,
			redirect_uri: CLIENT_REDIRECT,
			client_id: clientId,
			code_verifier: (await pkce()).verifier,
			resource,
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_grant" });
	});
});

describe("the token endpoint is rate-limited", () => {
	it("429s once the per-IP limit is exceeded", async () => {
		// It never passes through Hono, so rateLimitMiddleware does not cover it — and
		// it is unauthenticated by definition, since public clients have no secret.
		// wrangler.test.toml sets RATE_LIMIT_AUTH_MAX=3 and setup.ts clears the counter
		// before each test, so the 4th request here is the first over the line.
		const ip = "192.0.2.44";
		const body = { grant_type: "authorization_code", code: "nope", client_id: "nope" };
		for (let i = 0; i < 3; i++) {
			expect((await exchange(body, ip)).status).not.toBe(429);
		}
		expect((await exchange(body, ip)).status).toBe(429);
	});
});

describe("hardening the consent screen itself", () => {
	let workspaceId: string;
	let email: string;

	beforeEach(async () => {
		const workspace = await seedWorkspace();
		workspaceId = workspace.id;
		email = `hardening-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const user = await seedUser(email);
		await seedMember(workspaceId, user.id, "member");
	});

	async function consentPage(): Promise<Response> {
		const { clientId } = await seedOAuthClient();
		const { challenge } = await pkce();
		return SELF.fetch(
			authorizeUrl({ clientId, challenge, resource: `${HOST}/mcp/${workspaceId}` }),
			{
				headers: browserHeaders({ "Cf-Access-Jwt-Assertion": await accessJwt(email) }),
			}
		);
	}

	it("cannot be framed, and its form cannot be retargeted", async () => {
		// Clickjacking is the attack a consent screen exists to be protected from:
		// frame it invisibly under something the user wants to click and "Allow access"
		// gets pressed on their behalf.
		const res = await consentPage();
		const csp = res.headers.get("Content-Security-Policy") ?? "";

		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("refuses to process consent at all when JWT_SECRET is unset", async () => {
		// Without this the secret stringifies into the HMAC key as "undefined", which
		// is the same key on every deployment that skipped `wrangler secret put` — and
		// a forgeable consent token is a working CSRF against the one screen that
		// grants standing access.
		const saved = env.JWT_SECRET;
		env.JWT_SECRET = "" as unknown as string;
		try {
			const res = await consentPage();
			expect(res.status).toBe(500);
			expect(await res.text()).toContain("JWT_SECRET");
		} finally {
			env.JWT_SECRET = saved;
		}
	});
});

describe("workspace confinement survives a header that says otherwise", () => {
	it("403s an OAuth token aimed at its own workspace but labelled as another", async () => {
		// The provider's audience check looks at the URL path, and workspaceMiddleware
		// resolves the workspace from X-Workspace-Slug in preference to that path. A
		// token for workspace A on /mcp/A carrying `X-Workspace-Slug: B` therefore
		// passes the audience check and lands in B — unless the grant's workspace is
		// also enforced independently, which is what tokenWorkspaceId is for.
		const first = await seedWorkspace();
		const second = await seedWorkspace();
		const email = `confined-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const user = await seedUser(email);
		await seedMember(first.id, user.id, "admin");
		await seedMember(second.id, user.id, "admin");

		const { tokens } = await connect({ email, workspaceId: first.id });

		const res = await SELF.fetch(`${HOST}/mcp/${first.id}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
				"Content-Type": "application/json",
				"X-Workspace-Slug": second.slug,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_projects", arguments: {} },
			}),
		});

		expect(res.status).toBe(403);
	});
});

describe("existing credentials are untouched by the provider", () => {
	it("a pk_ API token still reaches the MCP endpoint", async () => {
		// The regression this guards: declaring /mcp/ an apiRoute makes the provider
		// answer every request there itself, 401ing anything that is not one of its own
		// tokens. index.ts only routes OAuth-shaped bearers into it for this reason.
		const fixture = await seedFixture();
		const res = await mcpCall(fixture.workspace.id, fixture.token, "list_projects");

		expect(res.status).toBe(200);
	});

	it("an unauthenticated MCP request still gets projektor's own 401 challenge", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch(`${HOST}/mcp/${fixture.workspace.id}`, {
			method: "POST",
			headers: browserHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			`${HOST}/.well-known/oauth-protected-resource/mcp/${fixture.workspace.id}`
		);
	});
});
