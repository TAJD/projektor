import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type { HonoEnv } from "@projektor/types";
import { type Context, Hono } from "hono";
import type { AuthUser } from "../middleware/auth";
import { isPublicViewer } from "../middleware/auth";
import { signConsentToken, verifyConsentToken } from "../oauth/consent-token";
import {
	describeScope,
	isLoopbackOnlyClient,
	lookupConsentWorkspace,
	OAuthRequestError,
	parseConsentRequest,
	relyingPartyHost,
} from "../services/oauth";

// PROJ-656: the consent screen.
//
// This is the one part of the OAuth flow the library deliberately does not own. It
// hands us a parsed authorization request and takes back a decision; everything
// between — who is asking, which workspace, and whether this human agrees — is
// projektor's, because only projektor knows what a workspace is.
//
// Server-rendered from the Worker rather than built as a page in apps/web (which the
// ticket originally proposed). The consent screen has to be correct on a deployment
// with no static assets at all — `wrangler dev` has no ASSETS binding — and it has to
// read the authorization request, resolve the workspace and mint a signed token in the
// same request that renders. Shipping it as an SPA island would mean a second
// round-trip through a JSON endpoint that has to reproduce all of the checks below,
// and an unstyled flash on the most security-sensitive page in the product.

export const oauthRouter = new Hono<HonoEnv>();

function helpers(c: Context<HonoEnv>): OAuthHelpers {
	return (c.env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const PAGE_STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#16181d; --muted:#5b6472; --line:#e3e6ea; --accent:#2f6feb; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1116; --card:#171a21; --fg:#e8eaed; --muted:#9aa3b2; --line:#282d38; --accent:#4c8dff; }
}
* { box-sizing: border-box; }
body { margin:0; padding:1.5rem 1rem; background:var(--bg); color:var(--fg);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
  display:flex; justify-content:center; align-items:flex-start; min-height:100vh; }
main { background:var(--card); border:1px solid var(--line); border-radius:12px;
  padding:1.75rem; width:100%; max-width:34rem; }
h1 { font-size:1.35rem; margin:0 0 .5rem; }
p { margin:0 0 1rem; color:var(--muted); }
strong { color:var(--fg); }
ul { margin:0 0 1.25rem; padding-left:1.25rem; }
li { margin-bottom:.35rem; }
.meta { font-size:.85rem; border-top:1px solid var(--line); padding-top:1rem; word-break:break-all; }
.warn { background:rgba(240,170,20,.12); border:1px solid rgba(240,170,20,.4);
  border-radius:8px; padding:.75rem 1rem; margin-bottom:1.25rem; font-size:.9rem; color:var(--fg); }
.actions { display:flex; flex-wrap:wrap; gap:.75rem; }
button { flex:1 1 10rem; min-height:44px; font:inherit; font-weight:600; border-radius:8px;
  border:1px solid var(--line); padding:.65rem 1rem; cursor:pointer; background:transparent; color:var(--fg); }
button[value="approve"] { background:var(--accent); border-color:var(--accent); color:#fff; }
`;

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

// A consent screen is the canonical clickjacking target: frame it invisibly over
// something the user wants to click and the "Allow access" button gets pressed for
// them. `frame-ancestors 'none'` is the control that stops it, with X-Frame-Options
// alongside for anything that predates CSP level 2. `form-action 'self'` keeps the
// decision POST from being retargeted, and `default-src 'none'` means the page cannot
// pull in anything at all — it needs nothing beyond its own inline stylesheet.
const CONSENT_HEADERS = {
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	// The URL carries the authorization request; nothing about it should be cached.
	"Cache-Control": "no-store",
} as const;

function consentHtml(
	c: Context<HonoEnv>,
	title: string,
	body: string,
	status: 200 | 400 | 403 | 500 = 200
) {
	return c.html(page(title, body), status, { ...CONSENT_HEADERS });
}

function errorPage(c: Context<HonoEnv>, status: 400 | 403 | 500, heading: string, detail: string) {
	return consentHtml(
		c,
		heading,
		`<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p>`,
		status
	);
}

/**
 * The key the consent token is signed with.
 *
 * Fails closed when JWT_SECRET is unset. Falling back to a default — or letting
 * `undefined` stringify into the key material, which is what happens if this is not
 * checked — would make the signing key identical on every deployment that skipped the
 * secret, and a forgeable consent token is a working CSRF against the one screen in
 * projektor that grants standing access.
 */
function consentSigningKey(c: Context<HonoEnv>): string | null {
	const secret = c.env.JWT_SECRET;
	return secret && secret.length > 0 ? secret : null;
}

const NO_SIGNING_KEY =
	"This projektor instance has no JWT_SECRET configured, so it cannot safely process " +
	"a consent request. Set it with `wrangler secret put JWT_SECRET` and try again.";

/**
 * Report an authorization failure the way OAuth expects.
 *
 * The library's contract is explicit: an AuthorizationError with no `redirectUri` has
 * not yet had the redirect target validated against the client's registered set, and a
 * caller MUST render locally rather than redirect — bouncing the browser to an
 * unvalidated URI would make this endpoint an open redirect. Once it is populated, the
 * URI has been checked, and redirecting is not merely safe but required: a client left
 * waiting on a callback that never arrives shows the user a hung tab, not an error.
 */
function authorizationFailure(c: Context<HonoEnv>, err: AuthorizationError) {
	if (!err.redirectUri) {
		return errorPage(c, 400, "Invalid authorization request", err.description);
	}
	const url = new URL(err.redirectUri);
	url.searchParams.set("error", err.code);
	url.searchParams.set("error_description", err.description);
	if (err.state) url.searchParams.set("state", err.state);
	// RFC 9207: error responses carry `iss` too, so a client with several
	// authorization servers configured can tell which one rejected it.
	if (err.issuer) url.searchParams.set("iss", err.issuer);
	return c.redirect(url.toString(), 302);
}

/**
 * The human who may consent, or null.
 *
 * Fails closed on the two identities that are not a human agreeing to anything:
 * an API token (`authKind === "agent"`) — letting a `pk_` token mint an OAuth grant
 * would upgrade a scoped credential into a long-lived one on the user's behalf — and
 * the shared PUBLIC_READ_ONLY viewer, which is not a person and is the same "user" for
 * every anonymous visitor on the internet. A deployment running with PUBLIC_READ_ONLY
 * and no Cloudflare Access has nobody who can authorize a connector, and must say so
 * rather than silently issuing a grant as the public viewer.
 */
function consentingUser(c: Context<HonoEnv>): AuthUser | null {
	if (c.get("authKind") !== "human") return null;
	const user = c.get("user") as AuthUser | undefined;
	if (!user || isPublicViewer(user)) return null;
	return user;
}

const NO_CONSENTER =
	"You are not signed in as a person who can authorize this. Sign in to projektor first; " +
	"anonymous read-only visitors and API tokens cannot connect an application.";

oauthRouter.get("/authorize", async (c) => {
	const user = consentingUser(c);
	if (!user) return errorPage(c, 403, "Sign-in required", NO_CONSENTER);

	const signingKey = consentSigningKey(c);
	if (!signingKey) return errorPage(c, 500, "Not configured", NO_SIGNING_KEY);

	// parseAuthRequest is also the client and redirect-URI validator: it resolves the
	// client (fetching and checking the CIMD document for a URL client_id) and rejects
	// a redirect_uri the client has not registered. Everything after this point can
	// therefore trust authRequest.redirectUri.
	let authRequest: AuthRequest;
	try {
		authRequest = await helpers(c).parseAuthRequest(c.req.raw);
	} catch (err) {
		if (err instanceof AuthorizationError) return authorizationFailure(c, err);
		return errorPage(
			c,
			400,
			"Unknown application",
			`The application could not be verified: ${String(err)}`
		);
	}

	let consent: ReturnType<typeof parseConsentRequest>;
	try {
		consent = parseConsentRequest(authRequest);
	} catch (err) {
		if (!(err instanceof OAuthRequestError)) throw err;
		return authorizationFailure(
			c,
			new AuthorizationError(err.code, {
				description: err.reason,
				redirectUri: authRequest.redirectUri,
				state: authRequest.state,
				issuer: authRequest.issuer,
			})
		);
	}

	// Read back for display only — parseAuthRequest already validated it.
	const client = await helpers(c).lookupClient(authRequest.clientId);
	if (!client) {
		return errorPage(
			c,
			400,
			"Unknown application",
			"This application is not registered with projektor."
		);
	}

	const workspace = await lookupConsentWorkspace(c.env.DB, user.id, consent.workspaceId);
	if (!workspace) {
		// Rendered locally, not redirected: whether this user is a member of that
		// workspace is not the client's business, and an `access_denied` bounce would
		// tell it. The human is the one who needs to know, and they are right here.
		return errorPage(
			c,
			403,
			"Workspace unavailable",
			"That workspace does not exist, or you are not a member of it."
		);
	}

	const token = await signConsentToken(
		{ userId: user.id, workspaceId: workspace.id, scopes: consent.scopes, authRequest },
		signingKey
	);

	const host = relyingPartyHost(authRequest.clientId);
	const name = client.clientName ?? host;
	const scopeItems = consent.scopes.map((s) => `<li>${escapeHtml(describeScope(s))}</li>`).join("");
	const loopbackWarning = isLoopbackOnlyClient(client.redirectUris)
		? `<div class="warn">This application receives its response on your own machine
       (<code>${escapeHtml(client.redirectUris[0])}</code>). projektor cannot verify which
       local program that is — only continue if you started this yourself.</div>`
		: "";

	return consentHtml(
		c,
		"Connect an application",
		`<h1>Connect ${escapeHtml(name)}?</h1>
       <p><strong>${escapeHtml(name)}</strong> is asking to access the
       <strong>${escapeHtml(workspace.name)}</strong> workspace as
       <strong>${escapeHtml(user.email)}</strong>.</p>
       ${loopbackWarning}
       <p>It will be able to:</p>
       <ul>${scopeItems}</ul>
       <p>Your own permissions still apply — you are a <strong>${escapeHtml(workspace.role)}</strong>
       here, and this application can never do more than you can.</p>
       <form method="post" action="/oauth/authorize">
         <input type="hidden" name="consent_token" value="${escapeHtml(token)}">
         <div class="actions">
           <button type="submit" name="decision" value="deny">Cancel</button>
           <button type="submit" name="decision" value="approve">Allow access</button>
         </div>
       </form>
       <p class="meta">Verified identity: <strong>${escapeHtml(host)}</strong>. The
       application's name is self-declared; the address above is not.</p>`
	);
});

oauthRouter.post("/authorize", async (c) => {
	const user = consentingUser(c);
	if (!user) return errorPage(c, 403, "Sign-in required", NO_CONSENTER);

	const signingKey = consentSigningKey(c);
	if (!signingKey) return errorPage(c, 500, "Not configured", NO_SIGNING_KEY);

	const form = await c.req.parseBody();
	const submitted = typeof form.consent_token === "string" ? form.consent_token : "";
	const payload = await verifyConsentToken(submitted, user.id, signingKey);
	if (!payload) {
		return errorPage(
			c,
			400,
			"This request has expired",
			"Start the connection again from the application."
		);
	}

	if (form.decision !== "approve") {
		// Safe to redirect: this redirect_uri came out of parseAuthRequest, which
		// validated it against the client's registered set, and the signature above
		// proves it has not been altered since. Telling the client explicitly beats
		// leaving it waiting on a callback that will never arrive.
		return authorizationFailure(
			c,
			new AuthorizationError("access_denied", {
				description: "The user declined the request",
				redirectUri: payload.authRequest.redirectUri,
				state: payload.authRequest.state,
				issuer: payload.authRequest.issuer,
			})
		);
	}

	const { redirectTo } = await helpers(c).completeAuthorization({
		request: payload.authRequest,
		userId: user.id,
		metadata: { workspaceId: payload.workspaceId, consentedAt: Math.floor(Date.now() / 1000) },
		scope: payload.scopes,
		// Carried on every request this grant authorizes; middleware/auth.ts turns it
		// back into projektor's own user + workspace + scope context.
		props: {
			userId: user.id,
			email: user.email,
			name: user.name,
			workspaceId: payload.workspaceId,
			scopes: payload.scopes,
		},
		// The library defaults this to true, which would revoke the user's other grants
		// for the same client. Grants here are per-workspace by design, so the default
		// would mean connecting a second workspace silently disconnects the first.
		revokeExistingGrants: false,
	});

	return c.redirect(redirectTo, 302);
});
