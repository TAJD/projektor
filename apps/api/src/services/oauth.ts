import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAUTH_SCOPE_READ, OAUTH_SCOPE_WRITE, OAUTH_SCOPES_SUPPORTED } from "../auth/scopes";

// PROJ-656: the parts of the authorization request that are projektor's business
// rather than the OAuth library's.
//
// The library validates the OAuth mechanics — response_type, PKCE, redirect_uri
// (including RFC 8252 §7.3 loopback port-ignoring, which is what makes Claude Code's
// ephemeral-port callback work), client_id and CIMD. What it cannot know is which
// projektor workspace a request is for, or whether the consenting human is allowed
// to grant access to it. That is here.

export class OAuthRequestError extends Error {
	/** The OAuth error code to report back to the client (RFC 6749 §4.1.2.1). */
	constructor(
		readonly code: "invalid_target" | "invalid_scope",
		readonly reason: string
	) {
		super(reason);
		this.name = "OAuthRequestError";
	}
}

/**
 * The workspace a `resource` parameter names, using the same path shape the MCP
 * endpoint itself uses.
 *
 * RFC 8707 `resource` is mandatory here rather than optional. Without it the grant
 * has no audience, and a token minted for one workspace would be indistinguishable
 * from a token for any other — the confinement `workspaceMiddleware` enforces would
 * be the only thing standing between them.
 */
export function workspaceIdFromResource(resource: string | string[] | undefined): string {
	if (resource === undefined) {
		throw new OAuthRequestError(
			"invalid_target",
			"A `resource` parameter naming the target workspace is required"
		);
	}
	// Multiple resources would mean one grant spanning several workspaces, which the
	// per-workspace audience binding is specifically designed to prevent.
	if (Array.isArray(resource)) {
		if (resource.length !== 1) {
			throw new OAuthRequestError("invalid_target", "Exactly one `resource` may be requested");
		}
		return workspaceIdFromResource(resource[0]);
	}

	let url: URL;
	try {
		url = new URL(resource);
	} catch {
		throw new OAuthRequestError("invalid_target", "`resource` is not a valid URL");
	}
	const workspaceId = /^\/mcp\/([^/]+)$/.exec(url.pathname)?.[1];
	if (!workspaceId) {
		throw new OAuthRequestError(
			"invalid_target",
			"`resource` must name an MCP endpoint, e.g. https://host/mcp/<id>"
		);
	}
	return decodeURIComponent(workspaceId);
}

/**
 * The scopes to grant, given what the client asked for.
 *
 * An empty or absent `scope` is read as "everything projektor offers" rather than
 * "nothing": a grant with no scopes is a token that can do nothing, which presents
 * to the user as a connector that silently fails every call. Anything the client
 * asks for that we do not issue is dropped rather than rejected — a client sending
 * `openid` or `offline_access` alongside real scopes should still get a working
 * grant, not an error page.
 */
export function grantedScopes(requested: readonly string[]): string[] {
	if (requested.length === 0) return [...OAUTH_SCOPES_SUPPORTED];
	const granted = OAUTH_SCOPES_SUPPORTED.filter((scope) => requested.includes(scope));
	if (granted.length === 0) {
		throw new OAuthRequestError(
			"invalid_scope",
			`No supported scopes requested. Supported: ${OAUTH_SCOPES_SUPPORTED.join(", ")}`
		);
	}
	return [...granted];
}

/** Plain-language description of a scope, for the consent screen. */
export function describeScope(scope: string): string {
	if (scope === OAUTH_SCOPE_READ) return "Read issues, wiki pages, projects and comments";
	if (scope === OAUTH_SCOPE_WRITE)
		return "Create and change issues, wiki pages, projects and comments";
	return scope;
}

/**
 * The relying party to show the user.
 *
 * Under CIMD the `client_id` is a self-asserted HTTPS URL, and the `client_name` in
 * the document it points at is chosen by the client — so the name is a claim, not an
 * identity. The host of the `client_id` URL is the only part backed by DNS and TLS,
 * so that is what the consent screen names.
 */
export function relyingPartyHost(clientId: string): string {
	try {
		return new URL(clientId).host;
	} catch {
		// A non-URL client_id predates CIMD (a DCR-issued opaque id). Show it verbatim
		// rather than inventing a hostname for it.
		return clientId;
	}
}

/**
 * True when every redirect URI the client registered is a loopback address.
 *
 * Worth warning about: any local process can bind a port and receive the
 * authorization code, so "the app on your machine" is not an identity claim the
 * authorization server can verify. Claude Code legitimately looks like this.
 */
export function isLoopbackOnlyClient(redirectUris: readonly string[]): boolean {
	if (redirectUris.length === 0) return false;
	return redirectUris.every((uri) => {
		try {
			const { hostname } = new URL(uri);
			return hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
		} catch {
			return false;
		}
	});
}

export type ConsentRequest = Readonly<{
	authRequest: AuthRequest;
	workspaceId: string;
	scopes: string[];
}>;

/** Validate the projektor-specific half of an authorization request. */
export function parseConsentRequest(authRequest: AuthRequest): ConsentRequest {
	return {
		authRequest,
		workspaceId: workspaceIdFromResource(authRequest.resource),
		scopes: grantedScopes(authRequest.scope),
	};
}

export type ConsentWorkspace = Readonly<{ id: string; name: string; slug: string; role: string }>;

/**
 * The workspace being consented to, if the signed-in user may consent for it.
 *
 * Returns null both for a workspace that does not exist and for one the user is not a
 * member of. The two are deliberately indistinguishable to the caller: the consent
 * screen is reachable by anyone with a session, and telling them which workspace ids
 * are real would turn it into an enumeration oracle.
 *
 * Role is returned rather than checked. Any member may connect a client; the role
 * remains the ceiling on what that client can then do, enforced where it always was —
 * in the service layer, on every call.
 */
export async function lookupConsentWorkspace(
	db: D1Database,
	userId: string,
	workspaceId: string
): Promise<ConsentWorkspace | null> {
	const row = await db
		.prepare(
			`SELECT w.id, w.name, w.slug, m.role
       FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
       WHERE w.id = ?`
		)
		.bind(userId, workspaceId)
		.first<{ id: string; name: string; slug: string; role: string | null }>();

	if (!row?.role) return null;
	return { id: row.id, name: row.name, slug: row.slug, role: row.role };
}
