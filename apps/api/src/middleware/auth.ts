import type { Env, HonoEnv } from "@projektor/types";
import type { Context, Next } from "hono";
import { capabilityForMethod, parseScopes, tokenAllows } from "../auth/scopes";
import { provisionUserOnLogin } from "../services/provisioning";
import { bumpRateCounter } from "./rate-limit";

// PROJ-198: bound bearer-token guessing per source IP. The request rate-limiter keys
// authenticated traffic by token fingerprint, so a flood of *distinct* invalid tokens
// from one IP would otherwise each land in its own bucket and never throttle. Count
// failed bearer auths per IP and 429 once they exceed RATE_LIMIT_AUTH_FAIL_MAX. Tokens
// are 256-bit random, so this is defense-in-depth, not the primary control.
async function tooManyAuthFailures(c: Context<HonoEnv>): Promise<boolean> {
	const ip = c.req.header("CF-Connecting-IP") ?? "127.0.0.1";
	const windowSecs = parseInt(c.env.RATE_LIMIT_WINDOW_SECS ?? "60", 10);
	const limit = parseInt(c.env.RATE_LIMIT_AUTH_FAIL_MAX ?? "50", 10);
	const count = await bumpRateCounter(c.env.DB, `authfail:${ip}`, windowSecs);
	return count > limit;
}

export interface AuthUser {
	id: string;
	email: string;
	name: string;
}

type AuthOutcome = { kind: "skip" } | { kind: "deny"; response: Response } | { kind: "allow" };

// 1. Cloudflare Access JWT (header or cookie)
async function tryCfAccessAuth(c: Context<HonoEnv>): Promise<AuthOutcome> {
	const cfJwt =
		c.req.header("Cf-Access-Jwt-Assertion") ??
		parseCookie(c.req.header("cookie") ?? "", "CF_Authorization");
	if (!cfJwt) return { kind: "skip" };

	const user = await validateCfAccessJwt(cfJwt, c.env);
	if (!user) return { kind: "deny", response: c.json({ error: "Invalid Access token" }, 401) };

	await provisionUserOnLogin(c.env, user);
	c.set("user", user);
	return { kind: "allow" };
}

async function tooManyAuthFailuresResponse(
	c: Context<HonoEnv>,
	message: string
): Promise<Response> {
	return (await tooManyAuthFailures(c))
		? c.json({ error: "Too Many Requests" }, 429)
		: c.json({ error: message }, 401);
}

// PROJ-17: enforce the token's scope. REST is gated here by HTTP method
// (the single chokepoint where a token is authenticated). MCP is gated
// per-tool in routes/mcp.ts, since one POST /mcp can carry a read OR a
// write tool call, so method-based classification doesn't apply there.
function checkTokenScope(
	c: Context<HonoEnv>,
	scopes: ReturnType<typeof parseScopes>
): Response | null {
	if (c.req.path.startsWith("/mcp/")) return null;
	const required = capabilityForMethod(c.req.method);
	if (!tokenAllows(scopes, required)) {
		return c.json({ error: `Token lacks '${required}' scope` }, 403);
	}
	return null;
}

async function authenticateApiToken(c: Context<HonoEnv>, token: string): Promise<AuthOutcome> {
	const hash = await hashToken(token);
	const row = await c.env.DB.prepare(
		`SELECT at.workspace_id, at.expires_at, at.scopes,
              u.id as user_id, u.email, u.name
       FROM api_tokens at
       LEFT JOIN users u ON u.id = at.user_id
       WHERE at.token_hash = ?`
	)
		.bind(hash)
		.first<{
			user_id: string;
			email: string;
			name: string;
			workspace_id: string | null;
			expires_at: number | null;
			scopes: string | null;
		}>();

	if (!row) {
		return { kind: "deny", response: await tooManyAuthFailuresResponse(c, "Unauthorized") };
	}
	if (row.expires_at && row.expires_at < Date.now() / 1000) {
		return { kind: "deny", response: await tooManyAuthFailuresResponse(c, "Token expired") };
	}

	const scopes = parseScopes(row.scopes);
	const scopeError = checkTokenScope(c, scopes);
	if (scopeError) return { kind: "deny", response: scopeError };

	c.set("user", { id: row.user_id, email: row.email, name: row.name } satisfies AuthUser);
	c.set("tokenWorkspaceId", row.workspace_id);
	c.set("tokenScopes", scopes);

	c.executionCtx.waitUntil(
		c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
			.bind(Math.floor(Date.now() / 1000), hash)
			.run()
	);

	return { kind: "allow" };
}

// 2. API token (Authorization: Bearer <token>)
async function tryBearerTokenAuth(c: Context<HonoEnv>): Promise<AuthOutcome> {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) return { kind: "skip" };

	const token = authHeader.slice(7);
	return authenticateApiToken(c, token);
}

// 3. Local dev bypass
async function tryDevBypassAuth(c: Context<HonoEnv>): Promise<AuthOutcome> {
	if (c.env.ENVIRONMENT !== "development" || !c.env.DEV_USER_EMAIL) return { kind: "skip" };

	const user = await upsertUserByEmail(c.env.DEV_USER_EMAIL, c.env.DB);
	await provisionUserOnLogin(c.env, user);
	c.set("user", user);
	return { kind: "allow" };
}

export async function authMiddleware(c: Context<HonoEnv>, next: Next) {
	for (const attempt of [tryCfAccessAuth, tryBearerTokenAuth, tryDevBypassAuth]) {
		const outcome = await attempt(c);
		if (outcome.kind === "deny") return outcome.response;
		if (outcome.kind === "allow") return next();
	}

	return c.json({ error: "Unauthorized" }, 401);
}

/**
 * Pure JWT verifier with injectable keys — no network I/O.
 * Exported so tests can generate a key pair, pre-populate keys[], and exercise
 * the validation logic without hitting CF's JWKS endpoint or KV.
 * The live path (validateCfAccessJwt) calls this after fetching/caching keys.
 */
type JwtHeader = { alg: string; kid?: string };
type JwtPayload = { exp: number; aud?: string | string[]; iss?: string; email: string };

function decodeJwtFields(parts: string[]): { header: JwtHeader; payload: JwtPayload } | null {
	try {
		const header = JSON.parse(base64urlDecode(parts[0]));
		const payload = JSON.parse(base64urlDecode(parts[1]));
		return { header, payload };
	} catch {
		return null;
	}
}

function jwtClaimsValid(
	header: JwtHeader,
	payload: JwtPayload,
	audience: string,
	issuer: string
): boolean {
	if (header.alg !== "RS256") return false;

	const now = Math.floor(Date.now() / 1000);
	if (payload.exp < now) return false;

	const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!aud.includes(audience)) return false;

	return payload.iss === issuer;
}

async function verifySignatureAgainstKeys(parts: string[], keys: JsonWebKey[]): Promise<boolean> {
	const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	const sig = base64urlToUint8Array(parts[2]);

	for (const jwk of keys) {
		try {
			const key = await crypto.subtle.importKey(
				"jwk",
				jwk,
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"]
			);
			if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signingInput)) return true;
		} catch {}
	}

	return false;
}

export async function verifyJwtPayload(
	jwt: string,
	keys: JsonWebKey[],
	audience: string,
	issuer: string
): Promise<{ email: string } | null> {
	const parts = jwt.split(".");
	if (parts.length !== 3) return null;

	const decoded = decodeJwtFields(parts);
	if (!decoded) return null;

	if (!jwtClaimsValid(decoded.header, decoded.payload, audience, issuer)) return null;

	const valid = await verifySignatureAgainstKeys(parts, keys);
	return valid ? { email: decoded.payload.email } : null;
}

async function validateCfAccessJwt(jwt: string, env: Env): Promise<AuthUser | null> {
	// Pre-screen without keys: avoids a JWKS fetch for obviously-invalid tokens.
	// Mirrors the order of checks in verifyJwtPayload so early exits fire first.
	const parts = jwt.split(".");
	if (parts.length !== 3) return null;
	try {
		const hdr = JSON.parse(base64urlDecode(parts[0]));
		if (hdr.alg !== "RS256") return null;
		const pld = JSON.parse(base64urlDecode(parts[1]));
		if (pld.exp < Math.floor(Date.now() / 1000)) return null;
		const aud = Array.isArray(pld.aud) ? pld.aud : [pld.aud];
		if (!aud.includes(env.CF_ACCESS_AUDIENCE)) return null;
		if (pld.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return null;
	} catch {
		return null;
	}
	// All field checks passed — now fetch keys and verify the signature.
	const keys = await getCfAccessKeys(env);
	const result = await verifyJwtPayload(
		jwt,
		keys,
		env.CF_ACCESS_AUDIENCE,
		`https://${env.CF_ACCESS_TEAM_DOMAIN}`
	);
	if (!result) return null;
	return upsertUserByEmail(result.email, env.DB, env.KV);
}

async function getCfAccessKeys(env: Env): Promise<JsonWebKey[]> {
	const cached = await env.KV.get("cf-access-certs", "json");
	if (cached) return cached as JsonWebKey[];

	const res = await fetch(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error("Failed to fetch CF Access certs");
	const { keys } = await res.json<{ keys: JsonWebKey[] }>();

	await env.KV.put("cf-access-certs", JSON.stringify(keys), { expirationTtl: 3600 });
	return keys;
}

async function upsertUserByEmail(
	email: string,
	db: D1Database,
	kv?: KVNamespace
): Promise<AuthUser> {
	if (kv) {
		const cached = await kv.get(`user-by-email:${email}`, "json");
		if (cached) return cached as AuthUser;
	}

	const id = crypto.randomUUID();
	const name = email.split("@")[0];
	const now = Math.floor(Date.now() / 1000);

	await db
		.prepare(
			`INSERT INTO users (id, email, name, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name`
		)
		.bind(id, email, name, now)
		.run();

	const user = await db
		.prepare("SELECT id, email, name FROM users WHERE email = ?")
		.bind(email)
		.first<AuthUser>();

	if (!user) throw new Error("Failed to upsert user");

	if (kv) {
		await kv.put(`user-by-email:${email}`, JSON.stringify(user), { expirationTtl: 300 });
	}

	return user;
}

function parseCookie(cookieHeader: string, name: string): string | undefined {
	for (const part of cookieHeader.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k.trim() === name) return rest.join("=").trim();
	}
	return undefined;
}

function base64urlDecode(s: string): string {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
	return atob(padded);
}

function base64urlToUint8Array(s: string): Uint8Array {
	const binary = base64urlDecode(s);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hashToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
