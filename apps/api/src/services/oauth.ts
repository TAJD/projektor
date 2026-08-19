import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { OAUTH_SCOPE_READ, OAUTH_SCOPE_WRITE, OAUTH_SCOPES_SUPPORTED } from "../auth/scopes";
import { NotFoundError } from "./errors";

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

// PROJ-659: the connector grants a user has issued, for Settings.
//
// Read from the OAuth library's KV store rather than a projektor table, because that is
// where grants live — see PROJ-658 for why there is no api_tokens row to mirror them into.

export type ConnectorGrant = Readonly<{
	id: string;
	/** Host of the client_id URL — see relyingPartyHost for why not client_name. */
	client: string;
	clientId: string;
	scopes: string[];
	grantedAt: number;
	expiresAt: number;
}>;

// A person accumulates a handful of connectors, not thousands. The page walk is bounded
// so a corrupt or hostile cursor cannot turn one settings request into an unbounded KV
// scan; if a user somehow exceeds it, the list truncates rather than hanging.
const GRANT_PAGE_SIZE = 100;
const GRANT_MAX_PAGES = 5;

// PROJ-660: how long an unredeemed grant is left alone before it is swept.
//
// A grant is written at consent time and only stamped with an expiry when the client
// redeems the authorization code. Between those two moments it is legitimate, so the
// sweep has to wait out the library's authorization-code lifetime — an hour is an
// order of magnitude past it, and a client that has not come back by then never will.
const ABANDONED_GRANT_GRACE_SECONDS = 3600;

/**
 * Every live grant this user has issued for this workspace.
 *
 * Scoped to the requesting user, not the workspace: a grant is a personal credential, so
 * any member can hold one and no admin can enumerate someone else's. That is the opposite
 * of `pk_` API tokens, which are workspace property and admin-only — the two lists sit
 * side by side in Settings and are deliberately governed differently.
 */
export async function listConnectorGrants(
	api: OAuthHelpers,
	userId: string,
	workspaceId: string
): Promise<ConnectorGrant[]> {
	const grants: ConnectorGrant[] = [];
	const abandoned: string[] = [];
	const now = Math.floor(Date.now() / 1000);
	let cursor: string | undefined;

	for (let page = 0; page < GRANT_MAX_PAGES; page++) {
		const result = await api.listUserGrants(userId, { limit: GRANT_PAGE_SIZE, cursor });
		for (const grant of result.items) {
			// PROJ-660, found by walking the real flow: the library stamps expiresAt onto a
			// grant only when the authorization code is redeemed for a refresh token. A
			// grant with none is one where the person pressed "Allow access" and the client
			// then never came back — an authorization that was started, not a connection
			// that exists. Listing it says "claude.ai is connected" about a client holding
			// no credential, and the Disconnect button beside it withdraws nothing.
			//
			// It is also the only kind of grant nothing ever cleans up: the library writes
			// it to KV with no expiration, and its own purge pass skips records without an
			// expiresAt. So an abandoned consent is swept here, where this user's grants are
			// already being enumerated — there is no global enumeration to sweep from, and
			// a user's own settings page is the one place their grants get walked.
			//
			// Both behaviours are safe only because projektor leaves refreshTokenTTL at its
			// default; setting it to undefined would issue refresh tokens with no expiry and
			// make every live grant look abandoned here. The tests below pin that.
			if (grant.expiresAt === undefined) {
				if (grant.createdAt < now - ABANDONED_GRANT_GRACE_SECONDS) abandoned.push(grant.id);
				continue;
			}
			// The workspace a grant is bound to is the one recorded at consent time.
			// A grant for another workspace belongs on that workspace's settings page.
			// Checked after the sweep above: an abandoned grant is dead in every workspace,
			// so leaving another workspace's stub behind would just leak it elsewhere.
			if ((grant.metadata as { workspaceId?: string } | null)?.workspaceId !== workspaceId) {
				continue;
			}
			grants.push({
				id: grant.id,
				client: relyingPartyHost(grant.clientId),
				clientId: grant.clientId,
				scopes: grant.scope,
				grantedAt: grant.createdAt,
				expiresAt: grant.expiresAt,
			});
		}
		if (!result.cursor) break;
		cursor = result.cursor;
	}

	// Never let the sweep fail the page it is riding on: the user asked to see their
	// connectors, not to garbage-collect KV.
	for (const grantId of abandoned) {
		try {
			await api.revokeGrant(grantId, userId);
		} catch {
			// Another request swept it first, or KV is unhappy. Either way it will be
			// picked up next time this list is loaded.
		}
	}

	return grants.sort((a, b) => b.grantedAt - a.grantedAt);
}

/**
 * Withdraw one connector.
 *
 * `revokeGrant` already refuses a grant belonging to a different user, so the ownership
 * check is the library's. The lookup here is for workspace scoping: revoking from
 * workspace A's settings page must not reach into a grant the same person holds for
 * workspace B, which would silently disconnect a client the page never showed them.
 */
export async function revokeConnectorGrant(
	api: OAuthHelpers,
	userId: string,
	workspaceId: string,
	grantId: string
): Promise<{ ok: true }> {
	const grants = await listConnectorGrants(api, userId, workspaceId);
	if (!grants.some((grant) => grant.id === grantId)) {
		throw new NotFoundError("Connector not found");
	}
	await api.revokeGrant(grantId, userId);
	return { ok: true };
}
