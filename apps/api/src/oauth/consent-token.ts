import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

// PROJ-656: the value that carries an authorization request across the consent screen.
//
// The consent POST needs CSRF protection, and it needs the authorization request it is
// approving to be exactly the one that was displayed. A hidden field holding the raw
// query string gives neither: an attacker's page can POST a form to another origin, so
// without a bound secret a cross-site request would silently mint a grant on the
// victim's session for the attacker's client — and without integrity, a tampered field
// would consent to a different client or a wider scope than the screen showed.
//
// So the whole displayed decision is serialised and signed. Verification re-checks the
// signature, the expiry, and that the session presenting it is the same session it was
// issued to. Nothing here is secret — it is integrity and origin-binding, not
// confidentiality — so the payload is plain base64url, not encrypted.

const CONSENT_TTL_SECS = 600;

export type ConsentPayload = {
	/** The user the token was issued to. A different session cannot spend it. */
	userId: string;
	workspaceId: string;
	scopes: string[];
	authRequest: AuthRequest;
	exp: number;
};

function b64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
	const padded =
		value.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"]
	);
}

export async function signConsentToken(
	payload: Omit<ConsentPayload, "exp">,
	secret: string
): Promise<string> {
	const full: ConsentPayload = {
		...payload,
		exp: Math.floor(Date.now() / 1000) + CONSENT_TTL_SECS,
	};
	const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(full)));
	const sig = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(secret),
		new TextEncoder().encode(body)
	);
	return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Returns the payload, or null for anything that is not a live, intact, own-session token. */
export async function verifyConsentToken(
	token: string,
	userId: string,
	secret: string
): Promise<ConsentPayload | null> {
	const [body, sig] = token.split(".");
	if (!body || !sig) return null;

	let valid: boolean;
	try {
		valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret),
			b64urlDecode(sig),
			new TextEncoder().encode(body)
		);
	} catch {
		return null;
	}
	if (!valid) return null;

	let payload: ConsentPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
	} catch {
		return null;
	}

	if (payload.exp < Math.floor(Date.now() / 1000)) return null;
	// The signature proves the payload is ours; this proves it is *this* session's.
	// Without it a token phished from one user could be replayed by another.
	if (payload.userId !== userId) return null;
	return payload;
}
