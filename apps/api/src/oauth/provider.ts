import {
	getOAuthApi,
	type OAuthHelpers,
	OAuthProvider,
	type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "@projektor/types";
import { OAUTH_SCOPES_SUPPORTED } from "../auth/scopes";
import { bumpRateCounter } from "../middleware/rate-limit";

// PROJ-656/657: the OAuth 2.1 token lifecycle, delegated to Cloudflare's provider.
//
// Why the library at all: it brings PKCE, single-use authorization codes, rotating
// refresh tokens, RFC 7009 revocation, RFC 8707 resource indicators, CIMD client
// registration, and RFC 8252 §7.3 loopback redirect matching — the last of which is
// what makes Claude Code's ephemeral-port callback work. That is the half of OAuth
// that is dangerous to hand-roll. See PROJ-654 for the evidence behind adopting it.
//
// Pinned exactly. The package is pre-1.0 and its surface has moved recently (CIMD,
// resolveExternalToken and ExternalTokenError are all recent additions), so a float
// on the minor is a float on our token security.

// The library's own access tokens are `<userId>:<grantId>:<secret>`. index.ts routes a
// request to the provider only when the bearer has that shape, so every other
// credential projektor accepts — `pk_` API tokens, the Cloudflare Access cookie, the
// dev bypass, the PUBLIC_READ_ONLY viewer — never enters the provider and keeps
// working exactly as before. Without that check, declaring /mcp/ an `apiRoute` would
// 401 every request that arrives without a bearer, silently breaking anonymous
// read-only instances (the live demo) and local dev.
export function isOAuthAccessToken(request: Request): boolean {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) return false;
	return header.slice(7).split(":").length === 3;
}

// Paths routed into the provider regardless of credential. The token endpoint it
// answers itself; the authorize endpoint it does NOT answer — it passes straight
// through to projektor's consent route — but it must still be routed here, because
// that pass-through is what injects `env.OAUTH_PROVIDER` (the OAuthHelpers the
// consent screen needs to parse the request and complete the grant).
export function isOAuthProviderPath(pathname: string): boolean {
	return pathname === TOKEN_ENDPOINT || pathname === AUTHORIZE_ENDPOINT;
}

// Revocation shares this URL: the provider handles issuance, refresh and RFC 7009
// revocation on the one token endpoint, which is why the discovery document
// advertises `revocation_endpoint` as the same path rather than a separate /oauth/revoke.
export const TOKEN_ENDPOINT = "/oauth/token";
export const AUTHORIZE_ENDPOINT = "/oauth/authorize";

function providerOptions(app: ExportedHandler<Env>): OAuthProviderOptions<Env> {
	return {
		// Only reached for requests index.ts has already identified as carrying an
		// OAuth access token; see isOAuthAccessToken above.
		apiRoute: "/mcp/",
		apiHandler: app as OAuthProviderOptions<Env>["apiHandler"],
		defaultHandler: app,
		// Not handled by the provider — it only advertises this URL. The consent
		// screen is projektor's own route (routes/oauth.ts), because the user is
		// authenticated by the existing Cloudflare Access session and the screen has
		// to name a workspace the provider knows nothing about.
		authorizeEndpoint: AUTHORIZE_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,
		clientIdMetadataDocumentEnabled: true,
		scopesSupported: [...OAUTH_SCOPES_SUPPORTED],
	};
}

export function createOAuthProvider(app: ExportedHandler<Env>) {
	return new OAuthProvider<Env>(providerOptions(app));
}

// Read/write access to grants from a normal Hono route (PROJ-659: Settings lists and
// revokes connectors). `env.OAUTH_PROVIDER` only exists on requests the provider itself
// routed, and a settings page request is not one of those — it carries a session cookie,
// not an OAuth token, so index.ts hands it straight to the app.
//
// The handlers in the options are never invoked on this path; getOAuthApi builds the
// helpers from the KV binding and the endpoint configuration alone. Passing a handler
// that throws would be a lie about what happens, so it 404s instead.
const HANDLER_UNUSED_HERE: ExportedHandler<Env> = {
	fetch: () => new Response("Not found", { status: 404 }),
};

export function oauthApi(env: Env): OAuthHelpers {
	return getOAuthApi(providerOptions(HANDLER_UNUSED_HERE), env);
}

/**
 * IP-keyed bound on the token endpoint, which the provider serves itself and which
 * therefore never passes through Hono's rateLimitMiddleware.
 *
 * A no-op for any other path — the authorize endpoint goes through Hono and is already
 * limited there, and limiting it twice would halve its effective budget.
 *
 * Fails open, matching rateLimitMiddleware: a D1 outage is a limiter problem, and
 * turning it into a blanket 500 would break every live connector rather than the
 * abusive one.
 */
export async function tokenEndpointRateLimited(
	request: Request,
	env: Env
): Promise<Response | null> {
	if (new URL(request.url).pathname !== TOKEN_ENDPOINT) return null;

	const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
	const windowSecs = parseInt(env.RATE_LIMIT_WINDOW_SECS ?? "60", 10);
	const limit = parseInt(env.RATE_LIMIT_AUTH_MAX ?? "300", 10);

	let count: number;
	try {
		count = await bumpRateCounter(env.DB, `oauth-token:${ip}`, windowSecs);
	} catch (err) {
		console.error("oauth token rate-limit counter unavailable, failing open", {
			err: String(err),
		});
		return null;
	}
	if (count <= limit) return null;

	return Response.json(
		{ error: "slow_down", error_description: "Too many token requests" },
		{ status: 429, headers: { "Retry-After": String(windowSecs) } }
	);
}
